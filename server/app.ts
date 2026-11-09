import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Invoices } from "./invoices.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import { AppError, type Actor, type ProblemCode } from "./store.ts";

export interface AppOptions {
  db: DatabaseSync;
  invoices: Invoices;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(invoices: Invoices, version: string) {
  return renderMetrics(version, { ...invoices.gauges(), fileError: !!invoices.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (INVOICES_METRICS_PORT). */
export function createMetricsHandler(invoices: Invoices, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(invoices, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The pages run nothing from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-linked": "Not linked",
  "link-failed": "Another service failed",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // A body too large is read to its end and dropped, so the answer reaches a client still sending; past four times
  // the limit the connection is cut.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new AppError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  path: string;
  auth: Access;
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({ db, invoices, version, auth, adminToken, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const created = (res: ServerResponse, data: unknown) => json(res, 201, data);
  const file = (res: ServerResponse, body: string | Buffer, type: string, filename: string) =>
    send(res, 200, body, type, { "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" });
  const I = invoices;
  const P = "/api/v1";

  const routes: Route[] = [
    { method: "GET", path: `${P}/version`, auth: "none", handle: () => ({ product: "invoices", version }) },
    { method: "GET", path: `${P}/products`, auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: `${P}/summary`, auth: "viewer", handle: () => I.summary() },
    { method: "GET", path: `${P}/overview`, auth: "viewer", handle: () => I.overview() },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: `${P}/settings`, auth: "viewer", handle: () => I.settings() },
    { method: "GET", path: `${P}/rates`, auth: "viewer", handle: ({ url }) => I.getRate(url.searchParams) },

    { method: "GET", path: `${P}/customers`, auth: "viewer", handle: ({ url }) => ({ customers: I.listCustomers(url.searchParams) }) },
    { method: "POST", path: `${P}/customers`, auth: "editor", handle: async ({ res, who, body }) => created(res, I.createCustomer(who, await body())) },
    {
      method: "POST",
      path: `${P}/customers/import`,
      auth: "editor",
      limit: 4 * 1024 * 1024,
      handle: async ({ who, body }) => I.importCustomers(who, await body()),
    },
    { method: "GET", path: `${P}/customers/:id`, auth: "viewer", handle: ({ params }) => I.getCustomer(params[0]!) },
    { method: "PATCH", path: `${P}/customers/:id`, auth: "editor", handle: async ({ who, params, body }) => I.updateCustomer(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/customers/:id`, auth: "editor", handle: ({ res, who, params }) => (I.removeCustomer(who, params[0]!), noContent(res)) },
    { method: "POST", path: `${P}/customers/:id/check`, auth: "editor", handle: ({ params }) => I.checkCustomer(params[0]!) },

    { method: "GET", path: `${P}/catalog`, auth: "viewer", handle: ({ url }) => ({ items: I.listProducts(url.searchParams) }) },
    { method: "POST", path: `${P}/catalog`, auth: "editor", handle: async ({ res, who, body }) => created(res, I.createProduct(who, await body())) },
    {
      method: "POST",
      path: `${P}/catalog/import`,
      auth: "editor",
      limit: 4 * 1024 * 1024,
      handle: async ({ who, body }) => I.importProducts(who, await body()),
    },
    { method: "PATCH", path: `${P}/catalog/:id`, auth: "editor", handle: async ({ who, params, body }) => I.updateProduct(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/catalog/:id`, auth: "editor", handle: ({ res, who, params }) => (I.removeProduct(who, params[0]!), noContent(res)) },

    { method: "GET", path: `${P}/invoices`, auth: "viewer", handle: ({ url }) => ({ invoices: I.listInvoices(url.searchParams) }) },
    { method: "POST", path: `${P}/invoices`, auth: "editor", handle: async ({ res, who, body }) => created(res, I.createInvoice(who, await body())) },
    // Totals as issuing would write them, for a draft being written; nothing is saved.
    { method: "POST", path: `${P}/invoices/preview`, auth: "viewer", handle: async ({ body }) => I.preview(await body()) },
    { method: "GET", path: `${P}/invoices/:id`, auth: "viewer", handle: ({ params }) => I.getInvoice(params[0]!) },
    { method: "PATCH", path: `${P}/invoices/:id`, auth: "editor", handle: async ({ who, params, body }) => I.updateInvoice(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/invoices/:id`, auth: "editor", handle: ({ res, who, params }) => (I.removeInvoice(who, params[0]!), noContent(res)) },
    { method: "POST", path: `${P}/invoices/:id/issue`, auth: "editor", handle: async ({ who, params, body }) => I.issue(who, params[0]!, await body()) },
    {
      method: "POST",
      path: `${P}/invoices/:id/credit-notes`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => created(res, I.creditNote(who, params[0]!, await body())),
    },
    { method: "POST", path: `${P}/invoices/:id/cancel`, auth: "editor", handle: ({ who, params }) => I.cancel(who, params[0]!) },
    { method: "POST", path: `${P}/invoices/:id/email`, auth: "editor", handle: async ({ who, params, body }) => I.emailNow(who, params[0]!, await body()) },
    {
      method: "POST",
      path: `${P}/invoices/:id/payments`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => created(res, I.addPayment(who, params[0]!, await body())),
    },
    {
      method: "GET",
      path: `${P}/invoices/:id/pdf`,
      auth: "viewer",
      handle: async ({ res, params }) => {
        const f = await I.invoiceFile(params[0]!);
        file(res, f.pdf, "application/pdf", f.filename);
      },
    },
    {
      method: "GET",
      path: `${P}/invoices/:id/xml`,
      auth: "viewer",
      handle: ({ res, params }) => {
        const f = I.invoiceXml(params[0]!);
        file(res, f.xml, "application/xml", f.filename);
      },
    },
    { method: "DELETE", path: `${P}/payments/:id`, auth: "editor", handle: ({ res, who, params }) => (I.removePayment(who, params[0]!), noContent(res)) },

    {
      method: "POST",
      path: `${P}/bank/statements`,
      auth: "editor",
      limit: 8 * 1024 * 1024,
      handle: async ({ res, who, body }) => created(res, I.importStatement(who, await body())),
    },
    { method: "GET", path: `${P}/bank/statements`, auth: "viewer", handle: () => ({ statements: I.listStatements() }) },
    { method: "GET", path: `${P}/bank/lines`, auth: "viewer", handle: ({ url }) => ({ lines: I.listBankLines(url.searchParams) }) },
    { method: "POST", path: `${P}/bank/lines/:id`, auth: "editor", handle: async ({ who, params, body }) => I.resolveBankLine(who, params[0]!, await body()) },

    { method: "GET", path: `${P}/recurring`, auth: "viewer", handle: () => ({ recurring: I.listRecurring() }) },
    { method: "POST", path: `${P}/recurring`, auth: "editor", handle: async ({ res, who, body }) => created(res, I.createRecurring(who, await body())) },
    { method: "GET", path: `${P}/recurring/:id`, auth: "viewer", handle: ({ params }) => I.getRecurring(params[0]!) },
    { method: "PATCH", path: `${P}/recurring/:id`, auth: "editor", handle: async ({ who, params, body }) => I.updateRecurring(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/recurring/:id`, auth: "editor", handle: ({ res, who, params }) => (I.removeRecurring(who, params[0]!), noContent(res)) },

    { method: "GET", path: `${P}/exports/counts`, auth: "viewer", handle: ({ url }) => I.exportCounts(url.searchParams) },
    {
      method: "GET",
      path: `${P}/exports/invoices.csv`,
      auth: "viewer",
      handle: ({ res, url }) => {
        const f = I.exportInvoices(url.searchParams);
        file(res, f.body, "text/csv; charset=utf-8", f.filename);
      },
    },
    {
      method: "GET",
      path: `${P}/exports/payments.csv`,
      auth: "viewer",
      handle: ({ res, url }) => {
        const f = I.exportPayments(url.searchParams);
        file(res, f.body, "text/csv; charset=utf-8", f.filename);
      },
    },
    {
      method: "GET",
      path: `${P}/exports/ubl.zip`,
      auth: "viewer",
      handle: ({ res, url }) => {
        const f = I.exportUbl(url.searchParams);
        file(res, f.body, "application/zip", f.filename);
      },
    },

    // What other products call.
    { method: "GET", path: `${P}/lookup`, auth: "viewer", handle: ({ url }) => I.lookup(url.searchParams) },
    { method: "POST", path: `${P}/billable-items`, auth: "editor", handle: async ({ res, who, body }) => json(res, 200, I.addBillable(who, await body())) },
    { method: "GET", path: `${P}/billable-items`, auth: "viewer", handle: ({ url }) => ({ items: I.listBillable(url.searchParams) }) },
    { method: "GET", path: `${P}/stock-movements`, auth: "viewer", handle: ({ url }) => I.stockMovements(url.searchParams) },
    {
      method: "POST",
      path: `${P}/crm/deals/:id`,
      auth: "editor",
      handle: async ({ res, who, params }) => {
        const r = await I.fromDeal(who, params[0]!);
        json(res, r.created ? 201 : 200, r.invoice);
      },
    },
    {
      method: "POST",
      path: `${P}/erasures`,
      auth: "admin",
      handle: async ({ res, body }) => {
        const r = I.erase(await body());
        json(res, r.status, r.body);
      },
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)").replace(/\./g, "\\.")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous", role: "viewer" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token", role: "admin" };
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: p.user.id, name: p.user.name, role: p.role } : { id: `token:${p.tokenId}`, name: p.name, role: p.role };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!invoices.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(invoices, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, r.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof AppError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // The lookup carries a customer's email in its query; only the path is logged.
    if (!["/healthz", "/metrics"].includes(routeName)) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
