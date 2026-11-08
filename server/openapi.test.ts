import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, startApp, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "invoices-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

const BINARY = ["application/pdf", "application/zip"];

async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (BINARY.includes(type)) return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/, and no screens", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/invoices`)).status).toBe(404);
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of ["/api/v1/products", "/api/v1/summary", "/api/v1/settings"]) {
      await call("GET", p, admin());
      await call("GET", p, {});
    }
    await call("GET", "/api/v1/rates", admin(), "/api/v1/rates?currency=USD&date=2026-11-02");
    await call("GET", "/api/v1/rates", admin(), "/api/v1/rates?currency=TRY");
    await call("GET", "/api/v1/rates", admin(), "/api/v1/rates?currency=USD&date=2026-06-01");
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("customers and the catalog", async () => {
    const c = {
      name: "Yıldız Mimarlık Ltd. Şti.",
      taxId: "9876543210",
      taxOffice: "Kordon",
      address: { street: "Atatürk Cad. 12", district: "Konak", city: "İzmir" },
      email: "muhasebe@yildiz.example",
    };
    ids.customer = (await call("POST", "/api/v1/customers", admin(c))).body.id;
    await call("POST", "/api/v1/customers", admin(c));
    await call("POST", "/api/v1/customers", admin({ name: "x", taxId: "123" }));
    await call("POST", "/api/v1/customers", admin("{"));
    ids.person = (
      await call(
        "POST",
        "/api/v1/customers",
        admin({ name: "Gülşen Öztürk", taxId: "10000000146", address: { district: "Kadıköy", city: "İstanbul" }, email: "g@example.com" }),
      )
    ).body.id;
    await call("GET", "/api/v1/customers", admin(), "/api/v1/customers?q=yıldız");
    await call("GET", "/api/v1/customers/{id}", admin(), `/api/v1/customers/${ids.customer}`);
    await call("GET", "/api/v1/customers/{id}", admin(), "/api/v1/customers/missing");
    await call("PATCH", "/api/v1/customers/{id}", admin({ phone: "+90 232 000 00 00" }), `/api/v1/customers/${ids.customer}`);
    await call("PATCH", "/api/v1/customers/{id}", admin({ taxId: "10000000146" }), `/api/v1/customers/${ids.customer}`);
    await call("PATCH", "/api/v1/customers/{id}", admin({ email: "nope" }), `/api/v1/customers/${ids.customer}`);
    await call("PATCH", "/api/v1/customers/{id}", admin({}), "/api/v1/customers/missing");
    await call("POST", "/api/v1/customers/{id}/check", admin(), `/api/v1/customers/${ids.customer}/check`);
    await call("POST", "/api/v1/customers/{id}/check", admin(), "/api/v1/customers/missing/check");
    const noTax = (await call("POST", "/api/v1/customers", admin({ name: "Vergisiz", address: { city: "Ankara" } }))).body.id;
    await call("POST", "/api/v1/customers/{id}/check", admin(), `/api/v1/customers/${noTax}/check`);
    await call("DELETE", "/api/v1/customers/{id}", admin(), `/api/v1/customers/${noTax}`);
    await call("DELETE", "/api/v1/customers/{id}", admin(), `/api/v1/customers/${noTax}`);

    ids.item = (
      await call("POST", "/api/v1/catalog", admin({ code: "LIS-12", name: "Lisans, 12 ay", unitPrice: 900050, unit: "C62", kdvRate: 20, stock: true }))
    ).body.id;
    await call("POST", "/api/v1/catalog", admin({ code: "LIS-12", name: "Again", unitPrice: 1 }));
    await call("POST", "/api/v1/catalog", admin({ code: "X", name: "x", unitPrice: 1, kdvRate: 0 }));
    await call("POST", "/api/v1/catalog", admin("{"));
    await call("GET", "/api/v1/catalog", admin(), "/api/v1/catalog?q=lis");
    await call("PATCH", "/api/v1/catalog/{id}", admin({ unitPrice: 950000 }), `/api/v1/catalog/${ids.item}`);
    await call("PATCH", "/api/v1/catalog/{id}", admin({ unit: "BOX" }), `/api/v1/catalog/${ids.item}`);
    await call("PATCH", "/api/v1/catalog/{id}", admin({ code: "LIS-12" }), `/api/v1/catalog/${ids.item}`);
    await call("PATCH", "/api/v1/catalog/{id}", admin({}), "/api/v1/catalog/missing");
    const other = (await call("POST", "/api/v1/catalog", admin({ code: "OTHER", name: "Other", unitPrice: 1 }))).body.id;
    await call("PATCH", "/api/v1/catalog/{id}", admin({ code: "LIS-12" }), `/api/v1/catalog/${other}`);
    await call("DELETE", "/api/v1/catalog/{id}", admin(), `/api/v1/catalog/${other}`);
    await call("DELETE", "/api/v1/catalog/{id}", admin(), `/api/v1/catalog/${other}`);
  });

  it("invoices, from draft to sent", async () => {
    const draft = {
      customer: ids.customer,
      lines: [
        { product: "LIS-12", quantity: 2, discount: 10 },
        { name: "Kurulum", unitPrice: 250000, kdvRate: 10 },
      ],
    };
    ids.invoice = (await call("POST", "/api/v1/invoices", admin(draft))).body.id;
    await call("POST", "/api/v1/invoices", admin({ customer: ids.customer, lines: [] }));
    await call("POST", "/api/v1/invoices", admin({ customer: "missing", lines: [{ name: "x", unitPrice: 1 }] }));
    await call("POST", "/api/v1/invoices", admin("{"));
    await call("PATCH", "/api/v1/invoices/{id}", admin({ notes: "Sipariş 44", dueDate: "2026-11-20" }), `/api/v1/invoices/${ids.invoice}`);
    await call("PATCH", "/api/v1/invoices/{id}", admin({ lines: [{ name: "x" }] }), `/api/v1/invoices/${ids.invoice}`);
    await call("PATCH", "/api/v1/invoices/{id}", admin("{"), `/api/v1/invoices/${ids.invoice}`);
    await call("PATCH", "/api/v1/invoices/{id}", admin({}), "/api/v1/invoices/missing");
    await call("GET", "/api/v1/invoices/{id}/pdf", admin(), `/api/v1/invoices/${ids.invoice}/pdf`);
    await call("GET", "/api/v1/invoices/{id}/xml", admin(), `/api/v1/invoices/${ids.invoice}/xml`);
    await call("POST", "/api/v1/invoices/{id}/issue", admin({ date: "2026-12-01" }), `/api/v1/invoices/${ids.invoice}/issue`);
    await call("POST", "/api/v1/invoices/{id}/issue", admin({ date: "x" }), `/api/v1/invoices/${ids.invoice}/issue`);
    await call("POST", "/api/v1/invoices/{id}/issue", admin(), "/api/v1/invoices/missing/issue");
    await call("POST", "/api/v1/invoices/{id}/issue", admin("{"), `/api/v1/invoices/${ids.invoice}/issue`);
    const issued = (await call("POST", "/api/v1/invoices/{id}/issue", admin(), `/api/v1/invoices/${ids.invoice}/issue`)).body;
    expect(issued.number).toBe("ACM2026000000001");
    await call("POST", "/api/v1/invoices/{id}/issue", admin(), `/api/v1/invoices/${ids.invoice}/issue`);
    await call("PATCH", "/api/v1/invoices/{id}", admin({ notes: "x" }), `/api/v1/invoices/${ids.invoice}`);
    await call("DELETE", "/api/v1/invoices/{id}", admin(), `/api/v1/invoices/${ids.invoice}`);
    await app.invoices.deliver();
    await call("GET", "/api/v1/invoices", admin());
    await call("GET", "/api/v1/invoices", admin(), "/api/v1/invoices?status=owed&from=2026-11-01");
    await call("GET", "/api/v1/invoices", admin(), "/api/v1/invoices?status=nope");
    await call("GET", "/api/v1/invoices/{id}", admin(), `/api/v1/invoices/${issued.number}`);
    await call("GET", "/api/v1/invoices/{id}", admin(), "/api/v1/invoices/missing");
    await call("GET", "/api/v1/invoices/{id}/pdf", admin(), "/api/v1/invoices/missing/pdf");
    const xml = await call("GET", "/api/v1/invoices/{id}/xml", admin(), `/api/v1/invoices/${ids.invoice}/xml`);
    expect(xml.body).toContain("<cbc:CustomizationID>TR1.2</cbc:CustomizationID>");
    await call("POST", "/api/v1/invoices/{id}/email", admin({ kind: "reminder" }), `/api/v1/invoices/${ids.invoice}/email`);
    await call("POST", "/api/v1/invoices/{id}/email", admin({ kind: "fax" }), `/api/v1/invoices/${ids.invoice}/email`);
    await call("POST", "/api/v1/invoices/{id}/email", admin(), "/api/v1/invoices/missing/email");
    app.mailer.fail = true;
    await call("POST", "/api/v1/invoices/{id}/email", admin(), `/api/v1/invoices/${ids.invoice}/email`);
    app.mailer.fail = false;
    const d2 = (await call("POST", "/api/v1/invoices", admin({ customer: ids.customer, lines: [{ name: "x", unitPrice: 100 }] }))).body.id;
    await call("POST", "/api/v1/invoices/{id}/email", admin(), `/api/v1/invoices/${d2}/email`);
    await call("DELETE", "/api/v1/invoices/{id}", admin(), `/api/v1/invoices/${d2}`);
    await call("DELETE", "/api/v1/invoices/{id}", admin(), `/api/v1/invoices/${d2}`);
    const usd = (await call("POST", "/api/v1/invoices", admin({ customer: ids.customer, currency: "USD", lines: [{ name: "x", unitPrice: 100 }] }))).body.id;
    app.fakes.tcmb.bulletins.clear();
    await app.invoices.store.run("DELETE FROM exchange_rates");
    await call("POST", "/api/v1/invoices/{id}/issue", admin(), `/api/v1/invoices/${usd}/issue`);
  });

  it("payments, credit notes, cancelling", async () => {
    const p = (await call("POST", "/api/v1/invoices/{id}/payments", admin({ amount: 100000, date: "2026-11-02" }), `/api/v1/invoices/${ids.invoice}/payments`))
      .body;
    await call("POST", "/api/v1/invoices/{id}/payments", admin({ amount: 999999999 }), `/api/v1/invoices/${ids.invoice}/payments`);
    await call("POST", "/api/v1/invoices/{id}/payments", admin({ amount: 1.5 }), `/api/v1/invoices/${ids.invoice}/payments`);
    await call("POST", "/api/v1/invoices/{id}/payments", admin({ amount: 1 }), "/api/v1/invoices/missing/payments");
    await call("POST", "/api/v1/invoices/{id}/payments", admin("{"), `/api/v1/invoices/${ids.invoice}/payments`);
    await call("DELETE", "/api/v1/payments/{id}", admin(), `/api/v1/payments/${p.id}`);
    await call("DELETE", "/api/v1/payments/{id}", admin(), `/api/v1/payments/${p.id}`);
    const cn = (
      await call(
        "POST",
        "/api/v1/invoices/{id}/credit-notes",
        admin({ lines: [{ line: 1, quantity: 1 }], reason: "İade" }),
        `/api/v1/invoices/${ids.invoice}/credit-notes`,
      )
    ).body;
    await call("POST", "/api/v1/invoices/{id}/credit-notes", admin({ lines: [{ line: 9 }] }), `/api/v1/invoices/${ids.invoice}/credit-notes`);
    await call("POST", "/api/v1/invoices/{id}/credit-notes", admin(), "/api/v1/invoices/missing/credit-notes");
    await call("POST", "/api/v1/invoices/{id}/credit-notes", admin(), `/api/v1/invoices/${cn.id}/credit-notes`);
    await call("POST", "/api/v1/invoices/{id}/credit-notes", admin("{"), `/api/v1/invoices/${ids.invoice}/credit-notes`);
    await call("POST", "/api/v1/invoices/{id}/issue", admin(), `/api/v1/invoices/${cn.id}/issue`);
    const ea = (await call("POST", "/api/v1/invoices", admin({ customer: ids.person, lines: [{ name: "Ders", unitPrice: 50000 }] }))).body.id;
    await call("POST", "/api/v1/invoices/{id}/issue", admin(), `/api/v1/invoices/${ea}/issue`);
    await call("POST", "/api/v1/invoices/{id}/cancel", admin(), `/api/v1/invoices/${ea}/cancel`);
    await app.invoices.deliver();
    await call("POST", "/api/v1/invoices/{id}/cancel", admin(), `/api/v1/invoices/${ea}/cancel`);
    await call("POST", "/api/v1/invoices/{id}/cancel", admin(), "/api/v1/invoices/missing/cancel");
    ids.ea = ea;
  });

  it("bank statements and recurring invoices", async () => {
    const content = `Tarih;Açıklama;Tutar;Dekont No\n02.11.2026;HAVALE ACM2026000000001;100,00;D-1\n02.11.2026;BİLİNMEYEN;5,00;D-2\n`;
    await call("POST", "/api/v1/bank/statements", admin({ account: "garanti", filename: "kasim.csv", content }));
    await call("POST", "/api/v1/bank/statements", admin({ account: "nope", content }));
    await call("POST", "/api/v1/bank/statements", admin("{"));
    await call("POST", "/api/v1/bank/statements", admin({ account: "garanti", content: "x".repeat(9 * 1024 * 1024) }));
    const lines = (await call("GET", "/api/v1/bank/lines", admin())).body.lines;
    await call("GET", "/api/v1/bank/lines", admin(), "/api/v1/bank/lines?state=all");
    await call("GET", "/api/v1/bank/lines", admin(), "/api/v1/bank/lines?state=nope");
    await call("POST", "/api/v1/bank/lines/{id}", admin({ ignore: true }), `/api/v1/bank/lines/${lines[0].id}`);
    await call("POST", "/api/v1/bank/lines/{id}", admin({ invoice: "missing" }), "/api/v1/bank/lines/missing");
    const matched = (await call("GET", "/api/v1/bank/lines", admin(), "/api/v1/bank/lines?state=matched")).body.lines;
    await call("POST", "/api/v1/bank/lines/{id}", admin({ invoice: ids.invoice }), `/api/v1/bank/lines/${matched[0].id}`);
    await call("POST", "/api/v1/bank/lines/{id}", admin({ nope: 1 }), `/api/v1/bank/lines/${lines[0].id}`);

    const r = (
      await call(
        "POST",
        "/api/v1/recurring",
        admin({ name: "Bakım", customer: ids.customer, lines: [{ name: "Bakım", unitPrice: 100000 }], start: "2026-12-01" }),
      )
    ).body;
    await call("POST", "/api/v1/recurring", admin({ name: "x", customer: ids.customer, lines: [] }));
    await call("POST", "/api/v1/recurring", admin({ name: "x", customer: "missing", lines: [{ name: "x", unitPrice: 1 }] }));
    await call("POST", "/api/v1/recurring", admin("{"));
    await call("GET", "/api/v1/recurring", admin());
    await call("GET", "/api/v1/recurring/{id}", admin(), `/api/v1/recurring/${r.id}`);
    await call("GET", "/api/v1/recurring/{id}", admin(), "/api/v1/recurring/missing");
    await call("PATCH", "/api/v1/recurring/{id}", admin({ everyMonths: 3 }), `/api/v1/recurring/${r.id}`);
    await call("PATCH", "/api/v1/recurring/{id}", admin({ mode: "weekly" }), `/api/v1/recurring/${r.id}`);
    await call("PATCH", "/api/v1/recurring/{id}", admin({}), "/api/v1/recurring/missing");
    await call("DELETE", "/api/v1/recurring/{id}", admin(), `/api/v1/recurring/${r.id}`);
    await call("DELETE", "/api/v1/recurring/{id}", admin(), `/api/v1/recurring/${r.id}`);
  });

  it("exports", async () => {
    for (const p of ["/api/v1/exports/invoices.csv", "/api/v1/exports/payments.csv", "/api/v1/exports/ubl.zip"]) {
      await call("GET", p, admin(), `${p}?from=2026-11-01&to=2026-11-30`);
      await call("GET", p, admin(), `${p}?from=nope`);
    }
  });

  it("what other products call", async () => {
    await call("GET", "/api/v1/lookup", admin(), "/api/v1/lookup?email=muhasebe@yildiz.example");
    await call("GET", "/api/v1/lookup", admin(), "/api/v1/lookup?number=ACM2026000000001");
    await call("GET", "/api/v1/lookup", admin(), "/api/v1/lookup?email=nobody@example.com");
    await call("GET", "/api/v1/lookup", admin(), "/api/v1/lookup");
    await call("GET", "/api/v1/lookup", {}, "/api/v1/lookup?email=x@example.com");
    const item = {
      external_id: "time-1",
      customer: { taxId: "9876543210" },
      date: "2026-11-02",
      description: "Danışmanlık, Ece",
      quantity: 1.5,
      unitPrice: 200000,
    };
    await call("POST", "/api/v1/billable-items", admin({ items: [item] }));
    await call("POST", "/api/v1/billable-items", admin({ items: [{ ...item, customer: { taxId: "1111111110" } }] }));
    await call("POST", "/api/v1/billable-items", admin({ items: [] }));
    await call("POST", "/api/v1/billable-items", admin("{"));
    await call("GET", "/api/v1/billable-items", admin());
    await call("GET", "/api/v1/stock-movements", admin(), "/api/v1/stock-movements?after=0");
    await call("GET", "/api/v1/stock-movements", admin(), "/api/v1/stock-movements?after=-1");
    app.fakes.crm.deals.set("d-1", {
      id: "d-1",
      name: "Lisans",
      status: "won",
      value: 1000,
      currency: "TRY",
      closedAt: "2026-11-02T06:00:00.000Z",
      company: null,
      contact: { id: "c-1", name: "Kerem Aksoy", email: "kerem@aksoy.example" },
      quotes: [],
    });
    app.fakes.crm.deals.set("d-open", { id: "d-open", name: "Açık", status: "open", value: 1, currency: "TRY", quotes: [] });
    await call("POST", "/api/v1/crm/deals/{id}", admin(), "/api/v1/crm/deals/d-1");
    await call("POST", "/api/v1/crm/deals/{id}", admin(), "/api/v1/crm/deals/d-1");
    await call("POST", "/api/v1/crm/deals/{id}", admin(), "/api/v1/crm/deals/missing");
    await call("POST", "/api/v1/crm/deals/{id}", admin(), "/api/v1/crm/deals/d-open");
    app.apply((await import("./test-app.ts")).SETTINGS.replace("crm: { url: FAKES/crm", "crm: { url: http://127.0.0.1:1"));
    await call("POST", "/api/v1/crm/deals/{id}", admin(), "/api/v1/crm/deals/d-2");
    app.apply((await import("./test-app.ts")).SETTINGS);
    await call(
      "POST",
      "/api/v1/erasures",
      admin({ reference: "KVKK-1", product: "audience", people: { emails: ["muhasebe@yildiz.example"], phones: [], userIds: [] } }),
    );
    await call(
      "POST",
      "/api/v1/erasures",
      admin({ reference: "KVKK-2", product: "audience", people: { emails: ["kerem@aksoy.example"], phones: [], userIds: [] } }),
    );
    await call("POST", "/api/v1/erasures", admin({ reference: "KVKK-3", product: "audience" }));
    await call("POST", "/api/v1/erasures", admin("{"));
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
