import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { fakeIntegrator, nilvera } from "./integrator.ts";
import { createInvoices } from "./invoices.ts";
import { smtpMailer } from "./links.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.INVOICES_DB ?? "/data/invoices.db";
const configPath = process.env.INVOICES_CONFIG?.trim() || "/config/invoices.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
// true to serve the API without the web UI (ADR 0018).
const headless = process.env.INVOICES_HEADLESS === "true";
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.INVOICES_METRICS_PORT ? Number(process.env.INVOICES_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open Invoices at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and the
// links other products are given use it.
const publicUrl = (process.env.INVOICES_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.INVOICES_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "invoices",
  productName: "OpenAsy Invoices",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.INVOICES_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
let file: ReturnType<typeof watchConfig> | undefined;
// One fake integrator for the life of the process, so what was sent to it is still there after the file changes.
const fake = fakeIntegrator();
const invoices = createInvoices(db, {
  publicUrl,
  fileState: () => file?.state ?? null,
  mailer: (c) => (c.mail ? smtpMailer(c.mail, process.env[c.mail.password]) : null),
  integrator: (c) =>
    !c.integrator ? null : c.integrator.provider === "fake" ? fake : nilvera({ url: c.integrator.url, apiKey: process.env[c.integrator.apiKey] }),
});
// The settings come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config, text) => invoices.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, Invoices starts with the defaults, so a first look needs nothing written; nothing can be issued.
if (!invoices.config()) {
  invoices.setConfig(parseConfig(""), "");
  log("warn", "no settings file applied: using the defaults until it can be read; nothing can be issued", { file: configPath });
}
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    invoices,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(invoices, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "invoices started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl))
  log("warn", "INVOICES_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put it behind TLS (ADR 0026)", { url: publicUrl });
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => void invoices.tick(), 15_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
