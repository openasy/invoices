// Starts the app on a random port for tests, with the fake integrator in this process, the fakes of TCMB and CRM, and
// a mailer that keeps what it is given.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { bulletinXml, CRM_TOKEN, startFakes } from "./fakes.ts";
import { fakeIntegrator } from "./integrator.ts";
import { createInvoices } from "./invoices.ts";
import { crmLink, type Mail, type Mailer } from "./links.ts";
import type { Actor } from "./store.ts";
import { tcmb } from "./tcmb.ts";

export const ADMIN_TOKEN = "test-admin-token";

/** Members of the test install: Ece is an editor, Selin an admin, Veli a viewer. */
export const ECE: Actor = { id: "user-ece", name: "Ece Kılıç", role: "editor" };
export const SELIN: Actor = { id: "user-selin", name: "Selin Aydın", role: "admin" };
export const VELI: Actor = { id: "user-veli", name: "Veli Kaya", role: "viewer" };
const MEMBERS = [
  { ...ECE, email: "ece@example.com" },
  { ...SELIN, email: "selin@example.com" },
  { ...VELI, email: "veli@example.com" },
];

/** The settings file the tests start with; FAKES is replaced with the fake server's address. */
export const SETTINGS = `
time_zone: Europe/Istanbul
currency: TRY
language: tr
seller:
  name: Acme Yazılım A.Ş.
  tax_id: "1234567890"
  tax_office: Zincirlikuyu
  address: { street: "Büyükdere Cad. No:1", district: Şişli, city: İstanbul, postal_code: "34394" }
  email: fatura@acme.example
  iban: TR33 0006 1005 1978 6457 8413 26
  bank: Örnek Bankası
series: { e_fatura: ACM, e_arsiv: ACA }
payment_terms: 30d
integrator: { provider: fake, profile: TEMELFATURA, poll_every: 1m }
exchange_rates: { url: FAKES/tcmb, rate: forex_buying }
reminders: { before: [3d], after: [1d, 7d], at: "09:00" }
mail: { host: localhost, port: 2525, security: none, from: Acme Fatura <fatura@acme.example> }
bank:
  garanti:
    name: Garanti TL
    csv: { date: Tarih, amount: Tutar, description: Açıklama, reference: Dekont No }
  isbank: { format: mt940 }
crm: { url: FAKES/crm, token: CRM_TOKEN, check_every: 1m }
`;

/** A clock the test moves by hand: Monday 2 November 2026, 09:00 in Istanbul. */
export function fakeClock(start = Date.parse("2026-11-02T06:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; settings?: string } = {}) {
  const fakes = await startFakes();
  // Friday 30 October's bulletin is the rate of an invoice of Monday 2 November.
  fakes.tcmb.bulletins.set(
    "2026-10-30",
    bulletinXml("2026-10-30", { USD: { buying: "34.2512", selling: "34.3129" }, EUR: { buying: "37.1050", selling: "37.1719" } }),
  );
  const db = openDb(":memory:");
  const { settings = SETTINGS, version = "0.1.0", ...rest } = opts;
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "invoices", productName: "OpenAsy Invoices", origin: base });
  for (const m of MEMBERS)
    db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(
      m.id,
      m.email,
      m.name,
      m.role,
      new Date().toISOString(),
    );
  const mails: Mail[] = [];
  const mailer: Mailer & { fail: boolean } = {
    fail: false,
    async send(m) {
      if (this.fail) throw new Error("connect ECONNREFUSED");
      mails.push(m);
    },
    close() {},
  };
  const integrator = fakeIntegrator();
  const env = { CRM_TOKEN };
  const invoices = createInvoices(db, {
    publicUrl: base,
    env,
    clock,
    sendAtOnce: false,
    mailer: (c) => (c.mail ? mailer : null),
    integrator: (c) => (c.integrator ? integrator : null),
    rates: (c) => tcmb({ url: c.exchangeRates.url }),
    crm: (c) => (c.crm ? crmLink({ url: c.crm.url, token: env.CRM_TOKEN }) : null),
  });
  const apply = (text: string) => {
    const t = text.replaceAll("FAKES", fakes.base);
    return invoices.setConfig(parseConfig(t), t);
  };
  apply(settings);
  handler = createApp({ db, invoices, auth, adminToken: ADMIN_TOKEN, version, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakes.close();
  };
  return { db, invoices, auth, base, admin, clock, fakes, mails, mailer, integrator, apply, close };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** A company customer on GİB's e-Fatura list (the fake integrator lists every VKN), and a person who is not. */
export function seedCustomers(app: TestApp) {
  const company = app.invoices.createCustomer(ECE, {
    name: "Yıldız Mimarlık Ltd. Şti.",
    taxId: "9876543210",
    taxOffice: "Kordon",
    address: { street: "Atatürk Cad. 12", district: "Konak", city: "İzmir", postalCode: "35210" },
    email: "muhasebe@yildiz.example",
  });
  const person = app.invoices.createCustomer(ECE, {
    name: "Gülşen Öztürk Çağlar",
    taxId: "10000000146",
    address: { street: "Gül Sok. 3", district: "Kadıköy", city: "İstanbul" },
    email: "gulsen@example.com",
  });
  return { company, person };
}
