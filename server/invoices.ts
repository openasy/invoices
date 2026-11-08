// Invoices: customers, products and services, invoices and credit notes with their KDV and withholding, issuing them
// through the GİB integrator under GİB's numbering, payments and reminders, recurring invoices, bank statements matched
// to invoices, exports for the accountant, and what other products call (Helpdesk's lookup, Time's billable hours,
// Inventory's stock movements, Audience's erasures, CRM's won deals). The HTTP layer (app.ts) is outside; everything
// here works on the database and the applied settings.
//
// The rules the product page promises:
// - Numbers: one series per channel (e-Fatura, e-Arşiv) and year, GİB's 16 characters (ABC2026000000001). A number is
//   given only when an invoice is issued, in the same write transaction that fixes it, after its XML has passed the
//   checks, so a number is never skipped, never given twice, and never dated before the one before it.
// - A sent invoice is never changed; a credit note (an IADE invoice) corrects it. An invoice the integrator refused
//   before it reached GİB may be fixed and sent again under its number.
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { fingerprint, parseStatement, StatementError } from "./bank.ts";
import { configWarnings, isDefaultSeller, type Config, type ConfigFileState } from "./config.ts";
import { csv, decimal, zip } from "./exports.ts";
import { IntegratorError, type Channel, type IntegratorApi } from "./integrator.ts";
import { crmLink, LinkError, type CrmLink, type Mailer } from "./links.ts";
import { log } from "./log.ts";
import { formatMoney, invoicePdf } from "./pdf.ts";
import {
  addDays,
  AppError,
  bad,
  body,
  conflict,
  createStore,
  day,
  dayIn,
  daysBetween,
  int,
  isDay,
  isObj,
  minor,
  minuteIn,
  notFound,
  optDay,
  optEmail,
  optText,
  quantity,
  SYSTEM,
  text,
  type Actor,
} from "./store.ts";
import { rateFor, RateError, tcmb, type Bulletin, type RateSource } from "./tcmb.ts";
import { checkLineTax, invoiceTotals, taxIdKind, toTry, typeCode, type LineInput } from "./tax.ts";
import { amt, qty, rate4, UNITS, ublXml, validateUbl, type InvoiceDocument, type Party, type Profile } from "./ubl.ts";

type Row = Record<string, SQLInputValue>;

interface CustomerRow {
  id: string;
  name: string;
  tax_id: string;
  tax_office: string | null;
  street: string | null;
  district: string | null;
  city: string;
  postal_code: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  currency: string | null;
  payment_days: number | null;
  crm_company_id: string | null;
  einvoice_aliases: string | null;
  einvoice_checked_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ProductRow {
  id: string;
  code: string;
  name: string;
  unit: string;
  unit_price: number;
  currency: string;
  kdv_rate: number;
  withholding: string | null;
  exemption: string | null;
  stock: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export type Status = "draft" | "queued" | "waiting" | "delivered" | "accepted" | "rejected" | "refused" | "failed" | "cancelled";

interface InvoiceRow {
  id: string;
  kind: "invoice" | "credit_note";
  status: Status;
  channel: Channel | null;
  profile: Profile | null;
  type_code: string | null;
  series: string | null;
  year: number | null;
  seq: number | null;
  number: string | null;
  uuid: string | null;
  customer_id: string;
  seller: string | null;
  buyer: string | null;
  alias: string | null;
  issue_date: string | null;
  issue_time: string | null;
  due_date: string | null;
  currency: string;
  rate: number | null;
  rate_source: "tcmb" | "manual" | null;
  rate_date: string | null;
  notes: string | null;
  order_ref: string | null;
  period_start: string | null;
  period_end: string | null;
  original_id: string | null;
  source: string;
  source_ref: string | null;
  net: number;
  kdv: number;
  withheld: number;
  total: number;
  payable: number;
  xml: string | null;
  integrator_ref: string | null;
  integrator_detail: string | null;
  next_at: string | null;
  attempts: number;
  email_to: string | null;
  email: number;
  emailed_at: string | null;
  paid_at: string | null;
  created_at: string;
  created_by: string;
  issued_at: string | null;
  issued_by: string | null;
  updated_at: string;
}

interface LineRow {
  invoice_id: string;
  pos: number;
  product_id: string | null;
  code: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  discount: number;
  kdv_rate: number;
  withholding: string | null;
  withholding_tenths: number;
  exemption: string | null;
  stock: number;
}

/** Invoices that count as owed: issued and on their way or arrived, not refused, rejected or cancelled. */
export const OWED: Status[] = ["queued", "waiting", "delivered", "accepted"];
const OWED_SQL = OWED.map((s) => `'${s}'`).join(", ");
const EDITABLE: Status[] = ["draft", "refused", "failed"];
const LINE_KEYS = ["product", "code", "name", "description", "quantity", "unit", "unitPrice", "discount", "kdvRate", "withholding", "exemption"];
const DRAFT_KEYS = ["customer", "currency", "issueDate", "dueDate", "lines", "notes", "orderRef", "period", "rate", "email", "emailTo", "billableItems"];

export interface InvoicesOptions {
  publicUrl: string;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  /** The mail server for the applied file; null when it has none. */
  mailer?: (c: Config) => Mailer | null;
  /** The integrator for the applied file; null when it has none. */
  integrator?: (c: Config) => IntegratorApi | null;
  rates?: (c: Config) => RateSource;
  crm?: (c: Config) => CrmLink | null;
  fileState?: () => ConfigFileState | null;
  /** false to leave sending to tick() instead of starting it when an invoice is issued (the tests move the clock). */
  sendAtOnce?: boolean;
}

const backoff = (attempts: number) => Math.min(6 * 60, 2 ** Math.max(0, attempts - 1)) * 60_000;

/** Adds months to a day, keeping the day of the month where the month has it: 31 January and one month is 28 February. */
export function addMonths(d: string, months: number, dayOfMonth: number): string {
  const [y, m] = d.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(dayOfMonth, last)).padStart(2, "0")}`;
}

export function createInvoices(db: DatabaseSync, opts: InvoicesOptions) {
  const clock = opts.clock ?? Date.now;
  const s = createStore(db, clock);
  const env = opts.env ?? process.env;
  const publicUrl = opts.publicUrl.replace(/\/$/, "");
  let cfg: Config | null = null;
  let cfgText = "";
  let mailer: Mailer | null = null;
  let integrator: IntegratorApi | null = null;
  let rates: RateSource | null = null;
  let crm: CrmLink | null = null;
  const missingBulletins = new Set<string>();
  const emailTries = new Map<string, { n: number; next: number }>();
  const counters = { sent: new Map<string, number>(), reminders: new Map<string, number>(), emails: new Map<string, number>() };
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const config = () => {
    if (!cfg) throw new AppError(503, "internal-error", "No settings are applied yet.");
    return cfg;
  };
  const today = () => dayIn(clock(), config().timeZone);
  const event = (invoice: string, by: string, what: string, detail: string | null = null) =>
    s.run("INSERT INTO invoice_events (invoice_id, at, by_name, what, detail) VALUES (?, ?, ?, ?, ?)", invoice, s.iso(), by, what, detail);

  // ---- Customers ----

  const customerRow = (id: string) => {
    const c = s.one<CustomerRow>("SELECT * FROM customers WHERE id = ?", id);
    if (!c) throw notFound("The customer");
    return c;
  };

  function balances(customerId: string) {
    const rows = s.q<{ id: string; currency: string; due_date: string | null }>(
      `SELECT id, currency, due_date FROM invoices WHERE customer_id = ? AND kind = 'invoice' AND status IN (${OWED_SQL})`,
      customerId,
    );
    const owed = new Map<string, { currency: string; amount: number; overdue: number }>();
    const t = today();
    for (const r of rows) {
      const b = balanceOf(r.id);
      if (b <= 0) continue;
      const o = owed.get(r.currency) ?? { currency: r.currency, amount: 0, overdue: 0 };
      o.amount += b;
      if (r.due_date && r.due_date < t) o.overdue += b;
      owed.set(r.currency, o);
    }
    return [...owed.values()];
  }

  function customerOut(c: CustomerRow) {
    return {
      id: c.id,
      name: c.name,
      taxId: c.tax_id || null,
      kind: taxIdKind(c.tax_id) === "tckn" ? "person" : c.tax_id ? "company" : null,
      taxOffice: c.tax_office,
      address: { street: c.street, district: c.district, city: c.city, postalCode: c.postal_code, country: c.country },
      email: c.email,
      phone: c.phone,
      currency: c.currency,
      paymentDays: c.payment_days,
      crmCompany: c.crm_company_id,
      eInvoice: c.einvoice_checked_at
        ? {
            registered: JSON.parse(c.einvoice_aliases ?? "[]").length > 0,
            aliases: JSON.parse(c.einvoice_aliases ?? "[]") as string[],
            checkedAt: c.einvoice_checked_at,
          }
        : null,
      notes: c.notes,
      owed: balances(c.id),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    };
  }

  function readCustomer(v: unknown, partial: boolean) {
    const b = body(v, ["name", "taxId", "taxOffice", "address", "email", "phone", "currency", "paymentDays", "notes", "crmCompany"]);
    const out: Row = {};
    if (!partial || b.name !== undefined) out.name = text(b.name, "name", 200);
    if (b.taxId !== undefined || !partial) {
      const t = b.taxId === null || b.taxId === undefined ? "" : String(b.taxId).trim();
      if (t && !taxIdKind(t)) throw bad("taxId is a VKN (10 digits), a TCKN (11 digits, with its check digits), or 11111111111 for a person who gives none.");
      out.tax_id = t;
    }
    if (b.taxOffice !== undefined) out.tax_office = optText(b.taxOffice, "taxOffice", 80) ?? null;
    if (b.address !== undefined || !partial) {
      const a = b.address ?? {};
      if (!isObj(a)) throw bad("address is { street, district, city, postalCode, country }.");
      body(a, ["street", "district", "city", "postalCode", "country"]);
      out.street = optText(a.street, "address.street", 200) ?? null;
      out.district = optText(a.district, "address.district", 60) ?? null;
      out.city = text(a.city, "address.city", 60);
      out.postal_code = optText(a.postalCode, "address.postalCode", 10) ?? null;
      out.country = optText(a.country, "address.country", 60) ?? "Türkiye";
    }
    if (b.email !== undefined) out.email = optEmail(b.email) ?? null;
    if (b.phone !== undefined) out.phone = optText(b.phone, "phone", 40) ?? null;
    if (b.currency !== undefined) {
      const c = optText(b.currency, "currency", 3);
      if (c && !/^[A-Z]{3}$/.test(c)) throw bad("currency is a three-letter code, such as TRY or EUR.");
      out.currency = c ?? null;
    }
    if (b.paymentDays !== undefined) out.payment_days = b.paymentDays === null ? null : int(b.paymentDays, "paymentDays", 0, 365);
    if (b.notes !== undefined) out.notes = optText(b.notes, "notes", 2000) ?? null;
    if (b.crmCompany !== undefined) out.crm_company_id = optText(b.crmCompany, "crmCompany", 100) ?? null;
    return out;
  }

  function uniqueCheck(fields: Row, except: string | null) {
    const t = fields.tax_id;
    if (typeof t === "string" && t && t !== "11111111111") {
      const other = s.one<{ id: string; name: string }>("SELECT id, name FROM customers WHERE tax_id = ? AND id IS NOT ?", t, except);
      if (other) throw conflict(`${other.name} has this tax number already.`);
    }
    if (typeof fields.crm_company_id === "string") {
      const other = s.one<{ name: string }>("SELECT name FROM customers WHERE crm_company_id = ? AND id IS NOT ?", fields.crm_company_id, except);
      if (other) throw conflict(`${other.name} is linked to this CRM company already.`);
    }
  }

  function createCustomer(_who: Actor, v: unknown) {
    const f = readCustomer(v, false);
    uniqueCheck(f, null);
    const id = randomUUID();
    const now = s.iso();
    const cols = { id, ...f, created_at: now, updated_at: now };
    s.run(
      `INSERT INTO customers (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols)
        .map(() => "?")
        .join(", ")})`,
      ...Object.values(cols),
    );
    return customerOut(customerRow(id));
  }

  function updateCustomer(_who: Actor, id: string, v: unknown) {
    customerRow(id);
    const f = readCustomer(v, true);
    uniqueCheck(f, id);
    // A change after issuing changes nothing already issued: each invoice keeps the buyer as it was then.
    if (Object.keys(f).length)
      s.run(
        `UPDATE customers SET ${Object.keys(f)
          .map((k) => `${k} = ?`)
          .join(", ")}, updated_at = ? WHERE id = ?`,
        ...Object.values(f),
        s.iso(),
        id,
      );
    if (f.tax_id !== undefined) s.run("UPDATE customers SET einvoice_aliases = NULL, einvoice_checked_at = NULL WHERE id = ?", id);
    return customerOut(customerRow(id));
  }

  function removeCustomer(_who: Actor, id: string) {
    customerRow(id);
    const used = s.one<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND number IS NOT NULL", id)!.n;
    if (used) throw conflict("The customer has issued invoices, which are kept; it cannot be deleted.");
    s.tx(() => {
      s.run("DELETE FROM billable_items WHERE customer_id = ?", id);
      s.run("DELETE FROM recurring WHERE customer_id = ?", id);
      for (const d of s.q<{ id: string }>("SELECT id FROM invoices WHERE customer_id = ?", id)) s.run("DELETE FROM invoices WHERE id = ?", d.id);
      s.run("DELETE FROM customers WHERE id = ?", id);
    });
  }

  function listCustomers(p: URLSearchParams) {
    const q = p.get("q")?.trim();
    const rows = q
      ? s.q<CustomerRow>(
          "SELECT * FROM customers WHERE name LIKE ? OR tax_id = ? OR email = ? ORDER BY name COLLATE NOCASE LIMIT 500",
          `%${q}%`,
          q,
          q.toLowerCase(),
        )
      : s.q<CustomerRow>("SELECT * FROM customers ORDER BY name COLLATE NOCASE LIMIT 500");
    return rows.map(customerOut);
  }

  function getCustomer(id: string) {
    const c = customerRow(id);
    return {
      ...customerOut(c),
      invoices: s.q<InvoiceRow>("SELECT * FROM invoices WHERE customer_id = ? ORDER BY COALESCE(issue_date, created_at) DESC LIMIT 200", id).map(invoiceOut),
      billableItems: s
        .q<Record<string, unknown>>("SELECT * FROM billable_items WHERE customer_id = ? AND invoice_id IS NULL ORDER BY date", id)
        .map(billableOut),
    };
  }

  async function lookupEInvoice(c: CustomerRow) {
    const api = integrator;
    if (!api) throw new AppError(409, "not-linked", "No integrator is set in the file, so e-Fatura users cannot be looked up.");
    if (!c.tax_id) throw bad("The customer has no tax number.");
    try {
      const info = await api.lookup(c.tax_id);
      s.run("UPDATE customers SET einvoice_aliases = ?, einvoice_checked_at = ? WHERE id = ?", JSON.stringify(info.aliases), s.iso(), c.id);
      return info;
    } catch (err) {
      if (err instanceof IntegratorError) throw new AppError(502, "link-failed", err.message);
      throw err;
    }
  }

  async function checkCustomer(id: string) {
    await lookupEInvoice(customerRow(id));
    return customerOut(customerRow(id));
  }

  /** A customer named the ways other products name one: our id, a tax number, an email, or a CRM company. */
  function findCustomer(v: unknown, at: string): CustomerRow {
    if (typeof v === "string") return customerRow(v);
    if (!isObj(v)) throw bad(`${at} is a customer id, or { id }, { taxId }, { email } or { crmCompany }.`);
    body(v, ["id", "taxId", "email", "crmCompany"]);
    const c =
      typeof v.id === "string"
        ? s.one<CustomerRow>("SELECT * FROM customers WHERE id = ?", v.id)
        : typeof v.taxId === "string"
          ? s.one<CustomerRow>("SELECT * FROM customers WHERE tax_id = ? AND tax_id NOT IN ('', '11111111111')", v.taxId)
          : typeof v.crmCompany === "string"
            ? s.one<CustomerRow>("SELECT * FROM customers WHERE crm_company_id = ?", v.crmCompany)
            : typeof v.email === "string"
              ? s.one<CustomerRow>("SELECT * FROM customers WHERE email = ? ORDER BY created_at LIMIT 1", v.email.trim().toLowerCase())
              : undefined;
    if (!c) throw new AppError(404, "not-found", `${at}: no customer matches.`);
    return c;
  }

  // ---- Products and services ----

  const productRow = (id: string) => {
    const p = s.one<ProductRow>("SELECT * FROM products WHERE id = ? OR code = ?", id, id);
    if (!p) throw notFound("The product");
    return p;
  };
  const productOut = (p: ProductRow) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    unit: p.unit,
    unitPrice: p.unit_price,
    currency: p.currency,
    kdvRate: p.kdv_rate,
    withholding: p.withholding,
    exemption: p.exemption,
    stock: !!p.stock,
    active: !!p.active,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  });

  function readProduct(v: unknown, partial: boolean, current?: ProductRow) {
    const b = body(v, ["code", "name", "unit", "unitPrice", "currency", "kdvRate", "withholding", "exemption", "stock", "active"]);
    const c = config();
    const f: Row = {};
    if (!partial || b.code !== undefined) {
      const code = text(b.code, "code", 40);
      if (!/^[\p{L}\p{N}._/-]+$/u.test(code)) throw bad("code is letters, digits and . _ / -, such as YZL-48.");
      f.code = code;
    }
    if (!partial || b.name !== undefined) f.name = text(b.name, "name", 300);
    if (!partial || b.unit !== undefined) {
      const u = b.unit ?? "C62";
      if (typeof u !== "string" || !UNITS[u]) throw bad(`unit is one of ${Object.keys(UNITS).join(", ")} (UN/ECE codes: C62 piece, HUR hour, MON month).`);
      f.unit = u;
    }
    if (!partial || b.unitPrice !== undefined) f.unit_price = minor(b.unitPrice, "unitPrice");
    if (!partial || b.currency !== undefined) {
      const cur = b.currency === undefined ? c.currency : String(b.currency);
      if (!/^[A-Z]{3}$/.test(cur)) throw bad("currency is a three-letter code, such as TRY or EUR.");
      f.currency = cur;
    }
    if (!partial || b.kdvRate !== undefined) f.kdv_rate = b.kdvRate === undefined ? 20 : int(b.kdvRate, "kdvRate", 0, 100);
    if (b.withholding !== undefined) f.withholding = optText(b.withholding, "withholding", 3) ?? null;
    if (b.exemption !== undefined) f.exemption = optText(b.exemption, "exemption", 3) ?? null;
    if (b.stock !== undefined) {
      if (typeof b.stock !== "boolean") throw bad("stock is true for goods Inventory counts.");
      f.stock = b.stock ? 1 : 0;
    }
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") throw bad("active is true or false.");
      f.active = b.active ? 1 : 0;
    }
    const merged = {
      kdvRate: (f.kdv_rate ?? current?.kdv_rate) as number,
      withholding: (f.withholding !== undefined ? f.withholding : (current?.withholding ?? null)) as string | null,
      exemption: (f.exemption !== undefined ? f.exemption : (current?.exemption ?? null)) as string | null,
    };
    checkLineTax(merged, c.tax, "product");
    return f;
  }

  function createProduct(_who: Actor, v: unknown) {
    const f = readProduct(v, false);
    if (s.one("SELECT 1 FROM products WHERE code = ?", f.code as string)) throw conflict(`A product has the code ${String(f.code)} already.`);
    const id = randomUUID();
    const now = s.iso();
    const cols = { id, ...f, created_at: now, updated_at: now };
    s.run(
      `INSERT INTO products (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols)
        .map(() => "?")
        .join(", ")})`,
      ...Object.values(cols),
    );
    return productOut(productRow(id));
  }

  function updateProduct(_who: Actor, id: string, v: unknown) {
    const p = productRow(id);
    const f = readProduct(v, true, p);
    if (f.code !== undefined && s.one("SELECT 1 FROM products WHERE code = ? AND id <> ?", f.code as string, p.id))
      throw conflict(`A product has the code ${String(f.code)} already.`);
    if (Object.keys(f).length)
      s.run(
        `UPDATE products SET ${Object.keys(f)
          .map((k) => `${k} = ?`)
          .join(", ")}, updated_at = ? WHERE id = ?`,
        ...Object.values(f),
        s.iso(),
        p.id,
      );
    return productOut(productRow(p.id));
  }

  function removeProduct(_who: Actor, id: string) {
    const p = productRow(id);
    // A product on an invoice stays for the record; it is only taken off the list.
    if (s.one("SELECT 1 FROM invoice_lines WHERE product_id = ? LIMIT 1", p.id))
      s.run("UPDATE products SET active = 0, updated_at = ? WHERE id = ?", s.iso(), p.id);
    else s.run("DELETE FROM products WHERE id = ?", p.id);
  }

  function listProducts(p: URLSearchParams) {
    const q = p.get("q")?.trim();
    const all = p.get("all") === "true";
    return s
      .q<ProductRow>(
        `SELECT * FROM products WHERE (? OR active = 1) AND (? IS NULL OR name LIKE ? OR code LIKE ?) ORDER BY name COLLATE NOCASE LIMIT 1000`,
        all ? 1 : 0,
        q ?? null,
        `%${q ?? ""}%`,
        `%${q ?? ""}%`,
      )
      .map(productOut);
  }

  // ---- Lines and totals ----

  function readLine(v: unknown, at: string, currency: string): Omit<LineRow, "invoice_id" | "pos"> {
    if (!isObj(v)) throw bad(`${at} is { product, name, quantity, unitPrice, discount, kdvRate, withholding, exemption }.`);
    body(v, LINE_KEYS);
    const c = config();
    const p = v.product === undefined || v.product === null ? null : productRow(text(v.product, `${at}.product`, 100));
    if (p && v.unitPrice === undefined && p.currency !== currency)
      throw bad(`${at}: ${p.code} is priced in ${p.currency}, the invoice is in ${currency}; give unitPrice.`);
    const unit = v.unit ?? p?.unit ?? "C62";
    if (typeof unit !== "string" || !UNITS[unit]) throw bad(`${at}.unit is one of ${Object.keys(UNITS).join(", ")}.`);
    const discountRaw = v.discount ?? 0;
    if (typeof discountRaw !== "number" || discountRaw < 0 || discountRaw > 100 || Math.abs(Math.round(discountRaw * 100) - discountRaw * 100) > 1e-6)
      throw bad(`${at}.discount is a percentage from 0 to 100 with at most two decimals.`);
    const kdvRate = v.kdvRate === undefined ? (p?.kdv_rate ?? 20) : int(v.kdvRate, `${at}.kdvRate`, 0, 100);
    const withholding = v.withholding !== undefined ? (optText(v.withholding, `${at}.withholding`, 3) ?? null) : (p?.withholding ?? null);
    const exemption = v.exemption !== undefined ? (optText(v.exemption, `${at}.exemption`, 3) ?? null) : (p?.exemption ?? null);
    checkLineTax({ kdvRate, withholding, exemption }, c.tax, at);
    const unitPrice = v.unitPrice === undefined ? p?.unit_price : minor(v.unitPrice, `${at}.unitPrice`);
    if (unitPrice === undefined) throw bad(`${at}.unitPrice is required without a product.`);
    return {
      product_id: p?.id ?? null,
      code: v.code !== undefined ? (optText(v.code, `${at}.code`, 40) ?? null) : (p?.code ?? null),
      name: v.name !== undefined ? text(v.name, `${at}.name`, 300) : p ? p.name : text(v.name, `${at}.name`, 300),
      description: optText(v.description, `${at}.description`, 500) ?? null,
      quantity: v.quantity === undefined ? 1000 : quantity(v.quantity, `${at}.quantity`),
      unit,
      unit_price: unitPrice,
      discount: Math.round(discountRaw * 100),
      kdv_rate: kdvRate,
      withholding,
      withholding_tenths: withholding ? c.tax.withholding.get(withholding)!.tenths : 0,
      exemption,
      stock: p?.stock ?? 0,
    };
  }

  const lineInput = (
    l: Pick<LineRow, "quantity" | "unit_price" | "discount" | "kdv_rate" | "withholding" | "withholding_tenths" | "exemption">,
  ): LineInput => ({
    quantity: l.quantity,
    unitPrice: l.unit_price,
    discount: l.discount,
    kdvRate: l.kdv_rate,
    withholding: l.withholding,
    withholdingTenths: l.withholding_tenths,
    exemption: l.exemption,
  });

  const linesOf = (id: string) => s.q<LineRow>("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY pos", id);

  function writeLines(id: string, lines: Array<Omit<LineRow, "invoice_id" | "pos">>) {
    s.run("DELETE FROM invoice_lines WHERE invoice_id = ?", id);
    lines.forEach((l, i) => {
      const cols = { invoice_id: id, pos: i + 1, ...l };
      s.run(
        `INSERT INTO invoice_lines (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols)
          .map(() => "?")
          .join(", ")})`,
        ...Object.values(cols),
      );
    });
    const t = invoiceTotals(lines.map(lineInput));
    s.run("UPDATE invoices SET net = ?, kdv = ?, withheld = ?, total = ?, payable = ? WHERE id = ?", t.net, t.kdv, t.withheld, t.total, t.payable, id);
  }

  // ---- Invoices ----

  const invoiceRow = (id: string) => {
    const r = s.one<InvoiceRow>("SELECT * FROM invoices WHERE id = ? OR number = ?", id, id);
    if (!r) throw notFound("The invoice");
    return r;
  };

  const paidOf = (id: string) => s.one<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE invoice_id = ?", id)!.n;
  const creditedOf = (id: string) =>
    s.one<{ n: number }>(`SELECT COALESCE(SUM(payable), 0) AS n FROM invoices WHERE original_id = ? AND kind = 'credit_note' AND status IN (${OWED_SQL})`, id)!
      .n;
  function balanceOf(id: string): number {
    const r = s.one<{ payable: number; status: Status; kind: string }>("SELECT payable, status, kind FROM invoices WHERE id = ?", id)!;
    if (r.kind !== "invoice" || !OWED.includes(r.status)) return 0;
    return r.payable - paidOf(id) - creditedOf(id);
  }

  function invoiceOut(r: InvoiceRow) {
    const lines = linesOf(r.id);
    const t = invoiceTotals(lines.map(lineInput));
    const c = s.one<{ name: string }>("SELECT name FROM customers WHERE id = ?", r.customer_id);
    const buyer = r.buyer ? (JSON.parse(r.buyer) as Party) : null;
    const owed = r.kind === "invoice" && OWED.includes(r.status);
    const paid = paidOf(r.id);
    const credited = r.kind === "invoice" ? creditedOf(r.id) : 0;
    const balance = owed ? r.payable - paid - credited : 0;
    const t0 = cfg ? today() : null;
    const overdue = owed && balance > 0 && !!r.due_date && !!t0 && r.due_date < t0;
    const original = r.original_id ? s.one<{ id: string; number: string | null }>("SELECT id, number FROM invoices WHERE id = ?", r.original_id) : null;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      owed,
      channel: r.channel,
      profile: r.profile,
      type: r.type_code,
      number: r.number,
      uuid: r.uuid,
      customer: { id: r.customer_id, name: buyer?.name ?? c?.name ?? "" },
      issueDate: r.issue_date,
      issueTime: r.issue_time,
      dueDate: r.due_date,
      currency: r.currency,
      rate: r.rate === null ? null : { value: rate4(r.rate), date: r.rate_date, source: r.rate_source },
      notes: r.notes,
      orderRef: r.order_ref,
      period: r.period_start && r.period_end ? { start: r.period_start, end: r.period_end } : null,
      original: original ?? null,
      source: r.source,
      sourceRef: r.source_ref,
      lines: lines.map((l, i) => ({
        product: l.product_id,
        code: l.code,
        name: l.name,
        description: l.description,
        quantity: l.quantity / 1000,
        unit: l.unit,
        unitPrice: l.unit_price,
        discount: l.discount / 100,
        kdvRate: l.kdv_rate,
        withholding: l.withholding ? { code: l.withholding, share: `${l.withholding_tenths}/10` } : null,
        exemption: l.exemption,
        net: t.lines[i]!.net,
        kdv: t.lines[i]!.kdv,
        withheld: t.lines[i]!.withheld,
      })),
      totals: {
        gross: t.gross,
        discount: t.discount,
        net: t.net,
        kdv: t.kdv,
        withheld: t.withheld,
        total: t.total,
        payable: t.payable,
        kdvBreakdown: t.kdvBreakdown,
        withholdingBreakdown: t.withholdingBreakdown.map((w) => ({ code: w.code, share: `${w.tenths}/10`, base: w.base, amount: w.amount })),
      },
      tryTotals:
        r.rate === null
          ? null
          : {
              net: toTry(t.net, r.rate),
              kdv: toTry(t.kdv, r.rate),
              withheld: toTry(t.withheld, r.rate),
              total: toTry(t.total, r.rate),
              payable: toTry(t.payable, r.rate),
            },
      paid,
      credited,
      balance,
      overdue,
      daysOverdue: overdue ? daysBetween(r.due_date!, t0!) : 0,
      paidAt: r.paid_at,
      integrator: { ref: r.integrator_ref, detail: r.integrator_detail, attempts: r.attempts },
      alias: r.alias,
      email: !!r.email,
      emailTo: r.email_to,
      emailedAt: r.emailed_at,
      createdAt: r.created_at,
      createdBy: r.created_by,
      issuedAt: r.issued_at,
      issuedBy: r.issued_by,
      updatedAt: r.updated_at,
      url: `${publicUrl}/invoices/${r.id}`,
      pdf: `/api/v1/invoices/${r.id}/pdf`,
      xml: r.xml ? `/api/v1/invoices/${r.id}/xml` : null,
    };
  }

  function getInvoice(id: string) {
    const r = invoiceRow(id);
    return {
      ...invoiceOut(r),
      payments: s.q<Record<string, unknown>>("SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, created_at", r.id).map(paymentOut),
      creditNotes: s
        .q<{ id: string; number: string | null; status: string; payable: number; issue_date: string | null }>(
          "SELECT id, number, status, payable, issue_date FROM invoices WHERE original_id = ? ORDER BY created_at",
          r.id,
        )
        .map((x) => ({ id: x.id, number: x.number, status: x.status, payable: x.payable, issueDate: x.issue_date })),
      reminders: s
        .q<{ kind: string; days: number; sent_at: string; error: string | null }>("SELECT * FROM reminders WHERE invoice_id = ? ORDER BY sent_at", r.id)
        .map((x) => ({ kind: x.kind, days: x.days, sentAt: x.sent_at, error: x.error })),
      events: s
        .q<{ at: string; by_name: string; what: string; detail: string | null }>("SELECT * FROM invoice_events WHERE invoice_id = ? ORDER BY id", r.id)
        .map((e) => ({ at: e.at, by: e.by_name, what: e.what, detail: e.detail })),
    };
  }

  function listInvoices(p: URLSearchParams) {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    const status = p.get("status");
    if (status === "owed" || status === "overdue") where.push(`status IN (${OWED_SQL}) AND kind = 'invoice'`);
    else if (status) {
      if (!["draft", "queued", "waiting", "delivered", "accepted", "rejected", "refused", "failed", "cancelled"].includes(status))
        throw bad("status is owed, overdue, draft, queued, waiting, delivered, accepted, rejected, refused, failed or cancelled.");
      where.push("status = ?");
      args.push(status);
    }
    const kind = p.get("kind");
    if (kind) {
      if (kind !== "invoice" && kind !== "credit_note") throw bad("kind is invoice or credit_note.");
      where.push("kind = ?");
      args.push(kind);
    }
    if (p.get("customer")) {
      where.push("customer_id = ?");
      args.push(p.get("customer")!);
    }
    for (const [k, op] of [
      ["from", ">="],
      ["to", "<="],
    ] as const) {
      const v = p.get(k);
      if (v === null) continue;
      if (!isDay(v)) throw bad(`${k} is a day, YYYY-MM-DD.`);
      where.push(`issue_date ${op} ?`);
      args.push(v);
    }
    const q = p.get("q")?.trim();
    if (q) {
      where.push("(number LIKE ? OR customer_id IN (SELECT id FROM customers WHERE name LIKE ?))");
      args.push(`%${q}%`, `%${q}%`);
    }
    const rows = s.q<InvoiceRow>(
      `SELECT * FROM invoices ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(issue_date, substr(created_at, 1, 10)) DESC, number DESC LIMIT 1000`,
      ...args,
    );
    let out = rows.map(invoiceOut);
    if (status === "owed") out = out.filter((i) => i.balance > 0);
    if (status === "overdue") out = out.filter((i) => i.overdue);
    return out;
  }

  function readDraft(v: unknown, current: InvoiceRow | null) {
    const b = body(v, DRAFT_KEYS);
    const c = config();
    const f: Row = {};
    let customer: CustomerRow | null = current ? customerRow(current.customer_id) : null;
    if (b.customer !== undefined || !current) {
      customer = findCustomer(b.customer, "customer");
      f.customer_id = customer.id;
    }
    const currency = (() => {
      if (b.currency === undefined) return current?.currency ?? customer?.currency ?? c.currency;
      const x = String(b.currency);
      if (!/^[A-Z]{3}$/.test(x)) throw bad("currency is a three-letter code, such as TRY, EUR or USD.");
      return x;
    })();
    if (current && current.number && currency !== current.currency) throw conflict("An invoice that has a number keeps its currency.");
    f.currency = currency;
    if (b.issueDate !== undefined) {
      if (current?.number) throw conflict("An invoice that has a number keeps its date.");
      f.issue_date = optDay(b.issueDate, "issueDate") ?? null;
    }
    if (b.dueDate !== undefined) f.due_date = optDay(b.dueDate, "dueDate") ?? null;
    if (b.notes !== undefined) f.notes = optText(b.notes, "notes", 2000) ?? null;
    if (b.orderRef !== undefined) f.order_ref = optText(b.orderRef, "orderRef", 60) ?? null;
    if (b.period !== undefined) {
      if (b.period === null) f.period_start = f.period_end = null;
      else {
        if (!isObj(b.period)) throw bad("period is { start, end }.");
        body(b.period, ["start", "end"]);
        f.period_start = day(b.period.start, "period.start");
        f.period_end = day(b.period.end, "period.end");
        if ((f.period_end as string) < (f.period_start as string)) throw bad("period.end is on or after period.start.");
      }
    }
    if (b.rate !== undefined) {
      if (b.rate === null) Object.assign(f, { rate: null, rate_source: null, rate_date: null });
      else {
        const m = typeof b.rate === "string" ? /^(\d{1,6})(?:\.(\d{1,4}))?$/.exec(b.rate) : null;
        if (!m || currency === "TRY") throw bad('rate is TRY per unit of the currency with up to four decimals, such as "34.5678"; null takes TCMB\'s.');
        Object.assign(f, { rate: Number(m[1]) * 10000 + Number((m[2] ?? "").padEnd(4, "0")), rate_source: "manual", rate_date: null });
      }
    }
    if (currency === "TRY" && (current?.rate ?? null) !== null) Object.assign(f, { rate: null, rate_source: null, rate_date: null });
    if (b.email !== undefined) {
      if (typeof b.email !== "boolean") throw bad("email is true to email the invoice to the customer when it is issued.");
      f.email = b.email ? 1 : 0;
    }
    if (b.emailTo !== undefined) f.email_to = optEmail(b.emailTo, "emailTo") ?? null;
    let lines: Array<Omit<LineRow, "invoice_id" | "pos">> | undefined;
    if (b.lines !== undefined) {
      if (!Array.isArray(b.lines) || b.lines.length > 500) throw bad("lines is a list of up to 500 lines.");
      lines = b.lines.map((l, i) => readLine(l, `lines[${i}]`, currency));
    }
    let items: Array<Record<string, unknown>> = [];
    if (b.billableItems !== undefined) {
      if (!Array.isArray(b.billableItems) || b.billableItems.some((x) => typeof x !== "string")) throw bad("billableItems is a list of billable item ids.");
      items = (b.billableItems as string[]).map((id) => {
        const it = s.one<Record<string, unknown>>("SELECT * FROM billable_items WHERE id = ? OR external_id = ?", id, id);
        if (!it) throw new AppError(404, "not-found", `Billable item ${id} does not exist.`);
        if (it.invoice_id) throw conflict(`Billable item ${id} is on an invoice already.`);
        if (it.customer_id !== (customer?.id ?? f.customer_id)) throw bad(`Billable item ${id} is another customer's.`);
        if (it.currency !== currency) throw bad(`Billable item ${id} is in ${String(it.currency)}, the invoice in ${currency}.`);
        return it;
      });
      const fromItems = items.map((it) => {
        const line = { quantity: (it.quantity as number) / 1000, unit: it.unit, unitPrice: it.unit_price, kdvRate: it.kdv_rate, name: it.description };
        return readLine(line, `billableItems ${String(it.external_id)}`, currency);
      });
      const kept = lines ?? (current ? linesOf(current.id).map(({ invoice_id: _i, pos: _p, ...l }) => l) : []);
      lines = [...kept, ...fromItems];
    }
    return { f, lines, items };
  }

  function createInvoice(who: Actor, v: unknown, source = "manual", sourceRef: string | null = null) {
    const { f, lines, items } = readDraft(v, null);
    if (!lines?.length) throw bad("lines is a list of at least one line, or billableItems.");
    const id = randomUUID();
    const now = s.iso();
    s.tx(() => {
      const cols = { id, kind: "invoice", status: "draft", source, source_ref: sourceRef, created_at: now, created_by: who.name, updated_at: now, ...f };
      s.run(
        `INSERT INTO invoices (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols)
          .map(() => "?")
          .join(", ")})`,
        ...Object.values(cols),
      );
      writeLines(id, lines);
      for (const it of items) s.run("UPDATE billable_items SET invoice_id = ? WHERE id = ?", id, it.id as string);
      event(id, who.name, "drafted", source === "manual" ? null : source);
    });
    return getInvoice(id);
  }

  function updateInvoice(who: Actor, id: string, v: unknown) {
    const r = invoiceRow(id);
    if (!EDITABLE.includes(r.status)) throw conflict("A sent invoice is never changed; a credit note corrects it.");
    const { f, lines, items } = readDraft(v, r);
    if (lines && !lines.length) throw bad("An invoice has at least one line.");
    s.tx(() => {
      if (Object.keys(f).length)
        s.run(
          `UPDATE invoices SET ${Object.keys(f)
            .map((k) => `${k} = ?`)
            .join(", ")}, updated_at = ? WHERE id = ?`,
          ...Object.values(f),
          s.iso(),
          r.id,
        );
      if (lines) writeLines(r.id, lines);
      for (const it of items) s.run("UPDATE billable_items SET invoice_id = ? WHERE id = ?", r.id, it.id as string);
      event(r.id, who.name, "changed");
    });
    return getInvoice(r.id);
  }

  function removeInvoice(_who: Actor, id: string) {
    const r = invoiceRow(id);
    if (r.number) throw conflict("An invoice with a number is kept: its number cannot be skipped. A credit note corrects it.");
    s.run("DELETE FROM invoices WHERE id = ?", r.id);
  }

  /** The buyer as the invoice names them, from the customer's record. */
  function partyOf(c: CustomerRow): Party {
    return {
      name: c.name,
      taxId: c.tax_id,
      taxOffice: c.tax_office,
      address: { street: c.street, district: c.district, city: c.city, postalCode: c.postal_code, country: c.country },
      email: c.email,
      phone: c.phone,
    };
  }

  function documentOf(r: InvoiceRow, over: Partial<InvoiceDocument> = {}): InvoiceDocument {
    const c = config();
    const lines = linesOf(r.id);
    const t = invoiceTotals(lines.map(lineInput));
    const original = r.original_id ? s.one<InvoiceRow>("SELECT * FROM invoices WHERE id = ?", r.original_id) : undefined;
    const seller: Party = r.seller
      ? (JSON.parse(r.seller) as Party)
      : { ...c.seller, website: c.seller.website, mersis: c.seller.mersis, tradeRegistry: c.seller.tradeRegistry };
    return {
      uuid: r.uuid ?? "00000000-0000-4000-8000-000000000000",
      number: r.number ?? "",
      profile: r.profile ?? "EARSIVFATURA",
      type: (r.type_code as InvoiceDocument["type"]) ?? typeCode(lines.map(lineInput), r.kind === "credit_note", c.tax),
      issueDate: r.issue_date ?? today(),
      issueTime: r.issue_time ?? "00:00:00",
      dueDate: r.kind === "invoice" ? r.due_date : null,
      currency: r.currency,
      rate: r.rate,
      seller,
      buyer: r.buyer ? (JSON.parse(r.buyer) as Party) : partyOf(customerRow(r.customer_id)),
      lines: lines.map((l, i) => ({
        name: l.name,
        code: l.code,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unit_price,
        discount: l.discount,
        kdvRate: l.kdv_rate,
        withholding: l.withholding,
        exemption: l.exemption,
        totals: t.lines[i]!,
      })),
      totals: t,
      notes: [r.notes, c.notes].filter((n): n is string => !!n),
      reference: original?.number && original.issue_date ? { number: original.number, date: original.issue_date } : null,
      period: r.period_start && r.period_end ? { start: r.period_start, end: r.period_end } : null,
      orderReference: r.order_ref,
      iban: r.kind === "invoice" ? c.seller.iban : null,
      ...over,
    };
  }

  const rateCache = {
    get: (d: string, cur: string, kind: string) =>
      s.one<{ rate: number }>("SELECT rate FROM exchange_rates WHERE date = ? AND currency = ? AND kind = ?", d, cur, kind)?.rate,
    put: (b: Bulletin) => {
      for (const [cur, kinds] of b.rates)
        for (const [kind, rate] of Object.entries(kinds))
          s.run("INSERT OR REPLACE INTO exchange_rates (date, currency, kind, rate) VALUES (?, ?, ?, ?)", b.date, cur, kind, rate);
    },
    missing: (d: string) => missingBulletins.has(d),
    markMissing: (d: string) => void missingBulletins.add(d),
  };

  async function exchangeRate(currency: string, forDay: string) {
    const c = config();
    if (!rates) throw new AppError(503, "internal-error", "No exchange rate source.");
    try {
      return await rateFor(rates, rateCache, forDay, currency, c.exchangeRates.rate);
    } catch (err) {
      if (err instanceof RateError) throw new AppError(502, "link-failed", `${err.message} Give the rate on the invoice to issue it without TCMB.`);
      throw err;
    }
  }

  async function getRate(p: URLSearchParams) {
    const currency = p.get("currency") ?? "";
    if (!/^[A-Z]{3}$/.test(currency) || currency === "TRY") throw bad("currency is a three-letter code other than TRY.");
    const d = p.get("date") ?? today();
    if (!isDay(d)) throw bad("date is a day, YYYY-MM-DD.");
    const r = await exchangeRate(currency, d);
    return { currency, date: d, bulletin: r.date, kind: config().exchangeRates.rate, rate: rate4(r.rate) };
  }

  /** Issues an invoice: the integrator says e-Fatura or e-Arşiv, it gets its number and XML, and is queued to be sent. */
  async function issue(who: Actor, id: string, v: unknown) {
    const b = body(v ?? {}, ["date"]);
    const c = config();
    let r = invoiceRow(id);
    if (!EDITABLE.includes(r.status)) throw conflict(`The invoice is ${r.status}; only a draft, or one the integrator refused, is issued.`);
    if (isDefaultSeller(c)) throw new AppError(409, "not-linked", "The seller is not set in the file: your name, tax number, tax office and address.");
    if (!integrator) throw new AppError(409, "not-linked", "No integrator is set in the file, so nothing can be issued.");
    const customer = customerRow(r.customer_id);
    if (!customer.tax_id) throw bad("The customer has no tax number (VKN or TCKN); add it before issuing.");
    if (!customer.district && customer.country === "Türkiye") throw bad("The customer's address needs its district (ilçe), which GİB asks for.");
    if (customer.tax_id.length === 10 && !customer.tax_office) throw bad("A customer with a VKN needs its tax office.");
    const lines = linesOf(r.id);
    if (!lines.length) throw bad("The invoice has no lines.");
    const t = invoiceTotals(lines.map(lineInput));
    if (t.payable <= 0) throw bad("The invoice's total is 0.");
    // Lines written under an older file are checked against this one.
    lines.forEach((l, i) => checkLineTax({ kdvRate: l.kdv_rate, withholding: l.withholding, exemption: l.exemption }, c.tax, `lines[${i}]`));
    const type = typeCode(lines.map(lineInput), r.kind === "credit_note", c.tax);
    let original: InvoiceRow | undefined;
    if (r.kind === "credit_note") {
      original = s.one<InvoiceRow>("SELECT * FROM invoices WHERE id = ?", r.original_id!);
      if (!original || !OWED.includes(original.status)) throw conflict("The invoice this credit note corrects is not issued, or was cancelled or rejected.");
      const room = original.payable - creditedOf(original.id);
      if (t.payable > room)
        throw conflict(`The credit note is more than what is left to credit on ${original.number}: ${formatMoney(room, r.currency, c.language)}.`);
    }

    const date = r.number ? r.issue_date! : b.date !== undefined ? day(b.date, "date") : (r.issue_date ?? today());
    if (!r.number) {
      const t0 = today();
      if (date > t0) throw bad("An invoice is not dated in the future.");
      if (daysBetween(date, t0) > 7) throw bad("An invoice is issued within seven days of the delivery (VUK 231/5): its date is at most seven days ago.");
      if (original?.issue_date && date < original.issue_date) throw bad("A credit note is not dated before the invoice it corrects.");
    }
    // The integrator decides e-Fatura or e-Arşiv: a buyer on GİB's e-Fatura list gets e-Fatura, anyone else e-Arşiv.
    const info = await lookupEInvoice(customer);
    const channel: Channel = info.registered ? "e-fatura" : "e-arsiv";
    if (r.channel && r.number && r.channel !== channel)
      throw conflict(`${r.number} was numbered as ${r.channel}, but the buyer is now ${channel}; make a new invoice.`);
    const profile: Profile = channel === "e-arsiv" ? "EARSIVFATURA" : r.kind === "credit_note" ? "TEMELFATURA" : c.integrator!.profile;
    let rate = r.rate;
    let rateDate = r.rate_date;
    let rateSource = r.rate_source;
    if (r.currency !== "TRY" && r.rate_source !== "manual") {
      const x = await exchangeRate(r.currency, date);
      rate = x.rate;
      rateDate = x.date;
      rateSource = "tcmb";
    }

    s.tx(() => {
      r = invoiceRow(r.id);
      if (!EDITABLE.includes(r.status)) throw conflict(`The invoice is ${r.status} already.`);
      const series = channel === "e-fatura" ? c.series.eFatura : c.series.eArsiv;
      const year = Number(date.slice(0, 4));
      let number = r.number;
      let seq = r.seq;
      if (!number) {
        const last = s.one<{ last: number; last_date: string }>("SELECT last, last_date FROM number_series WHERE series = ? AND year = ?", series, year);
        if (last && last.last_date > date)
          throw conflict(
            `${series}'s last number of ${year} is dated ${last.last_date}; a later number cannot have an earlier date. Date it ${last.last_date} or later.`,
          );
        seq = (last?.last ?? 0) + 1;
        if (seq > 999_999_999) throw conflict(`${series} has used every number of ${year}.`);
        number = `${series}${year}${String(seq).padStart(9, "0")}`;
        s.run(
          "INSERT INTO number_series (series, year, last, last_date) VALUES (?, ?, ?, ?) ON CONFLICT (series, year) DO UPDATE SET last = excluded.last, last_date = excluded.last_date",
          series,
          year,
          seq,
          date,
        );
      }
      const uuid = randomUUID();
      const now = clock();
      const p = new Intl.DateTimeFormat("en-GB", { timeZone: c.timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now);
      const seller: Party = { ...c.seller };
      const buyer = partyOf(customer);
      const due = r.kind === "invoice" ? (r.due_date ?? addDays(date, customer.payment_days ?? c.paymentDays)) : null;
      const doc = documentOf(
        { ...r, rate, issue_date: date, due_date: due },
        { uuid, number, profile, type, issueDate: date, issueTime: p, dueDate: due, seller, buyer, rate },
      );
      const xml = ublXml(doc, c.tax);
      const problems = validateUbl(xml);
      if (problems.length) throw bad(`The UBL-TR XML would be refused: ${problems.join(" ")}`);
      s.run(
        `UPDATE invoices SET status = 'queued', channel = ?, profile = ?, type_code = ?, series = ?, year = ?, seq = ?, number = ?, uuid = ?, seller = ?, buyer = ?,
           alias = ?, issue_date = ?, issue_time = ?, due_date = ?, rate = ?, rate_date = ?, rate_source = ?, xml = ?, integrator_ref = NULL, integrator_detail = NULL,
           next_at = ?, attempts = 0, issued_at = COALESCE(issued_at, ?), issued_by = COALESCE(issued_by, ?), updated_at = ? WHERE id = ?`,
        channel,
        profile,
        type,
        series,
        year,
        seq,
        number,
        uuid,
        JSON.stringify(seller),
        JSON.stringify(buyer),
        channel === "e-fatura" ? (info.aliases[0] ?? null) : null,
        date,
        p,
        due,
        rate,
        rateDate,
        rateSource,
        xml,
        s.iso(now),
        s.iso(now),
        who.name,
        s.iso(now),
        r.id,
      );
      // Goods leave the stock when they are invoiced, and come back with a credit note: once per invoice.
      if (!s.one("SELECT 1 FROM stock_movements WHERE invoice_id = ?", r.id))
        for (const l of linesOf(r.id).filter((x) => x.stock && x.code))
          s.run(
            "INSERT INTO stock_movements (invoice_id, number, product_id, code, quantity, unit, date, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            r.id,
            number,
            l.product_id,
            l.code!,
            r.kind === "credit_note" ? l.quantity : -l.quantity,
            l.unit,
            date,
            s.iso(now),
          );
      event(r.id, who.name, r.status === "draft" ? "issued" : "issued again", `${number} as ${channel}, ${profile} ${type}`);
    });
    if (opts.sendAtOnce !== false) void deliver();
    return getInvoice(r.id);
  }

  function creditNote(who: Actor, id: string, v: unknown) {
    const b = body(v ?? {}, ["lines", "reason"]);
    const r = invoiceRow(id);
    if (r.kind !== "invoice" || !OWED.includes(r.status)) throw conflict("A credit note corrects an issued invoice that was not cancelled or rejected.");
    const lines = linesOf(r.id);
    let picked = lines;
    if (b.lines !== undefined) {
      if (!Array.isArray(b.lines) || !b.lines.length) throw bad("lines is a list of { line, quantity }: which lines are returned and how many.");
      picked = b.lines.map((x, i) => {
        if (!isObj(x)) throw bad(`lines[${i}] is { line, quantity }.`);
        body(x, ["line", "quantity"]);
        const l = lines.find((y) => y.pos === x.line);
        if (!l) throw bad(`lines[${i}].line is a line number of the invoice, 1 to ${lines.length}.`);
        const q = x.quantity === undefined ? l.quantity : quantity(x.quantity, `lines[${i}].quantity`);
        if (q > l.quantity) throw bad(`lines[${i}].quantity is at most the invoice's ${l.quantity / 1000}.`);
        return { ...l, quantity: q };
      });
    }
    const reason = optText(b.reason, "reason", 500) ?? null;
    const cid = randomUUID();
    const now = s.iso();
    s.tx(() => {
      s.run(
        `INSERT INTO invoices (id, kind, status, customer_id, currency, rate, rate_source, rate_date, notes, original_id, source, email, created_at, created_by, updated_at)
         VALUES (?, 'credit_note', 'draft', ?, ?, ?, ?, ?, ?, ?, 'credit', ?, ?, ?, ?)`,
        cid,
        r.customer_id,
        r.currency,
        r.rate,
        r.rate === null ? null : "manual",
        r.rate_date,
        [`${r.number} sayılı faturanın iadesi.`, reason].filter(Boolean).join(" "),
        r.id,
        r.email,
        now,
        who.name,
        now,
      );
      writeLines(
        cid,
        picked.map(({ invoice_id: _i, pos: _p, ...l }) => l),
      );
      event(cid, who.name, "drafted", `credit note of ${r.number}`);
      event(r.id, who.name, "credit note drafted", reason);
    });
    return getInvoice(cid);
  }

  async function cancel(who: Actor, id: string) {
    const r = invoiceRow(id);
    if (r.channel !== "e-arsiv") throw conflict("Only an e-Arşiv invoice can be cancelled; an e-Fatura is corrected with a credit note.");
    if (!["waiting", "delivered"].includes(r.status)) throw conflict(`The invoice is ${r.status}; only a sent e-Arşiv invoice is cancelled.`);
    if (paidOf(r.id) > 0) throw conflict("The invoice has payments; remove them first.");
    if (!integrator) throw new AppError(409, "not-linked", "No integrator is set in the file.");
    try {
      await integrator.cancel(r.uuid!);
    } catch (err) {
      if (err instanceof IntegratorError) throw new AppError(err.permanent ? 409 : 502, err.permanent ? "conflict" : "link-failed", err.message);
      throw err;
    }
    s.tx(() => {
      s.run("UPDATE invoices SET status = 'cancelled', next_at = NULL, updated_at = ? WHERE id = ?", s.iso(), r.id);
      reverseStock(r);
      event(r.id, who.name, "cancelled");
    });
    return getInvoice(r.id);
  }

  /** An invoice that will never stand (cancelled, rejected) gives its goods back to the stock. */
  function reverseStock(r: InvoiceRow) {
    for (const m of s.q<{ product_id: string | null; code: string; quantity: number; unit: string }>(
      "SELECT product_id, code, SUM(quantity) AS quantity, unit FROM stock_movements WHERE invoice_id = ? GROUP BY product_id, code, unit HAVING SUM(quantity) <> 0",
      r.id,
    ))
      s.run(
        "INSERT INTO stock_movements (invoice_id, number, product_id, code, quantity, unit, date, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        r.id,
        r.number ?? "",
        m.product_id,
        m.code,
        -m.quantity,
        m.unit,
        today(),
        s.iso(),
      );
  }

  // ---- Sending, the integrator's answers, emails ----

  let delivering: Promise<void> | null = null;
  /** Sends what is queued and asks about what is on its way. A call while it runs waits for that run, then runs again. */
  async function deliver(): Promise<void> {
    if (!cfg) return;
    if (delivering) await delivering.catch(() => undefined);
    if (delivering) return delivering;
    delivering = deliverAll().finally(() => {
      delivering = null;
    });
    return delivering;
  }

  async function deliverAll() {
    const due = s.q<InvoiceRow>(
      "SELECT * FROM invoices WHERE next_at IS NOT NULL AND next_at <= ? AND status IN ('queued', 'waiting', 'delivered') ORDER BY next_at LIMIT 50",
      s.iso(),
    );
    for (const r of due) await deliverOne(r);
    await emailIssued();
  }

  async function deliverOne(r: InvoiceRow) {
    const c = config();
    const api = integrator;
    if (!api) return;
    const now = clock();
    const poll = s.iso(now + c.integrator!.pollMinutes * 60_000);
    try {
      if (r.status === "queued") {
        const res = await api.send({ channel: r.channel!, uuid: r.uuid!, number: r.number!, xml: r.xml!, alias: r.alias });
        s.run(
          "UPDATE invoices SET status = 'waiting', integrator_ref = ?, integrator_detail = NULL, next_at = ?, attempts = 0, updated_at = ? WHERE id = ?",
          res.ref,
          poll,
          s.iso(),
          r.id,
        );
        event(r.id, api.provider, "sent to the integrator", res.ref);
        count(counters.sent, "sent");
        return;
      }
      const st = await api.status(r.channel!, r.uuid!);
      if (st.state === "waiting") {
        s.run("UPDATE invoices SET next_at = ?, attempts = 0 WHERE id = ?", poll, r.id);
        return;
      }
      if (st.state === r.status) {
        // A TICARIFATURA's buyer has eight days to accept or refuse it; after that nothing changes.
        const open = r.profile === "TICARIFATURA" && daysBetween(r.issue_date!, today()) <= 8;
        s.run("UPDATE invoices SET next_at = ?, attempts = 0 WHERE id = ?", open ? poll : null, r.id);
        return;
      }
      const status: Status = st.state === "failed" ? "failed" : st.state;
      const open = status === "delivered" && r.profile === "TICARIFATURA";
      s.tx(() => {
        s.run(
          "UPDATE invoices SET status = ?, integrator_detail = ?, next_at = ?, attempts = 0, updated_at = ? WHERE id = ?",
          status,
          st.detail,
          open ? poll : null,
          s.iso(),
          r.id,
        );
        if (status === "rejected" || status === "cancelled" || status === "failed") reverseStock(r);
        event(r.id, api.provider, status, st.detail);
      });
      count(counters.sent, status);
    } catch (err) {
      if (!(err instanceof IntegratorError)) throw err;
      if (err.permanent && r.status === "queued") {
        // Refused before it reached GİB: it is not an invoice yet, and may be fixed and issued again under its number.
        s.run("UPDATE invoices SET status = 'refused', integrator_detail = ?, next_at = NULL, updated_at = ? WHERE id = ?", err.message, s.iso(), r.id);
        event(r.id, api.provider, "refused", err.message);
        count(counters.sent, "refused");
        return;
      }
      const attempts = r.attempts + 1;
      s.run("UPDATE invoices SET attempts = ?, integrator_detail = ?, next_at = ? WHERE id = ?", attempts, err.message, s.iso(now + backoff(attempts)), r.id);
      log("warn", "integrator call failed; trying again", { invoice: r.number, attempts, error: err.message });
    }
  }

  async function invoiceFile(id: string) {
    const r = invoiceRow(id);
    const c = config();
    const pdf = await invoicePdf({
      doc: documentOf(r),
      tables: c.tax,
      language: c.language,
      draft: !r.number || EDITABLE.includes(r.status),
      balance: r.kind === "invoice" && OWED.includes(r.status) && paidOf(r.id) + creditedOf(r.id) > 0 ? balanceOf(r.id) : null,
      bank: c.seller.bank,
      footer: null,
    });
    return { pdf, filename: `${r.number ?? `taslak-${r.id.slice(0, 8)}`}.pdf` };
  }

  function invoiceXml(id: string) {
    const r = invoiceRow(id);
    if (!r.xml) throw notFound("The invoice's XML (it is a draft)");
    return { xml: r.xml, filename: `${r.number}.xml` };
  }

  async function mailInvoice(r: InvoiceRow, to: string, kind: "issued" | "reminder", daysOff = 0) {
    const c = config();
    if (!mailer) throw new AppError(409, "not-linked", "No mail server is set in the file.");
    const f = await invoiceFile(r.id);
    const tr = c.language === "tr";
    const balance = balanceOf(r.id);
    const buyer = r.buyer ? (JSON.parse(r.buyer) as Party).name : customerRow(r.customer_id).name;
    const money = (n: number) => formatMoney(n, r.currency, c.language);
    const due = r.due_date ? (tr ? r.due_date.split("-").reverse().join(".") : r.due_date) : "";
    const pay = c.seller.iban
      ? tr
        ? `\nÖdeme: ${c.seller.bank ?? ""} IBAN ${c.seller.iban}\n`
        : `\nPay to: ${c.seller.bank ?? ""} IBAN ${c.seller.iban}\n`
      : "";
    let subject: string;
    let lines: string[];
    if (kind === "issued") {
      subject = tr ? `Fatura ${r.number} - ${c.seller.name}` : `Invoice ${r.number} from ${c.seller.name}`;
      lines = tr
        ? [`Sayın ${buyer},`, "", `${r.number} numaralı faturanız ektedir.`, `Tutar: ${money(r.payable)}`, ...(due ? [`Son ödeme tarihi: ${due}`] : []), pay]
        : [`Dear ${buyer},`, "", `Invoice ${r.number} is attached.`, `Amount: ${money(r.payable)}`, ...(due ? [`Due: ${due}`] : []), pay];
    } else {
      const before = daysOff < 0;
      subject = tr ? `${before ? "Yaklaşan ödeme" : "Ödeme hatırlatması"}: ${r.number}` : `${before ? "Payment due soon" : "Payment reminder"}: ${r.number}`;
      lines = tr
        ? [
            `Sayın ${buyer},`,
            "",
            before
              ? `${r.number} numaralı faturanızın son ödeme tarihi ${due}.`
              : `${r.number} numaralı faturanızın son ödeme tarihi ${due} idi ve ödemesi henüz bize ulaşmadı.`,
            `Kalan tutar: ${money(balance)}`,
            pay,
            "Ödemeyi yaptıysanız bu mesajı dikkate almayınız.",
          ]
        : [
            `Dear ${buyer},`,
            "",
            before ? `Invoice ${r.number} is due on ${due}.` : `Invoice ${r.number} was due on ${due} and we have not received the payment yet.`,
            `Still owed: ${money(balance)}`,
            pay,
            "If you have paid already, please ignore this message.",
          ];
    }
    const attachments = [{ filename: f.filename, content: f.pdf, contentType: "application/pdf" }];
    if (r.xml) attachments.push({ filename: `${r.number}.xml`, content: Buffer.from(r.xml), contentType: "application/xml" });
    await mailer.send({ to, subject, text: [...lines, "", c.seller.name].join("\n"), attachments });
  }

  const emailOf = (r: InvoiceRow) => r.email_to ?? (r.buyer ? (JSON.parse(r.buyer) as Party).email : null) ?? customerRow(r.customer_id).email;

  async function emailIssued() {
    const c = config();
    if (!c.emailOnIssue || !mailer) return;
    for (const r of s.q<InvoiceRow>(
      "SELECT * FROM invoices WHERE email = 1 AND emailed_at IS NULL AND status IN ('waiting', 'delivered', 'accepted') ORDER BY issued_at LIMIT 20",
    )) {
      const to = emailOf(r);
      const tries = emailTries.get(r.id) ?? { n: 0, next: 0 };
      if (!to || tries.n >= 5 || tries.next > clock()) continue;
      try {
        await mailInvoice(r, to, "issued");
        s.run("UPDATE invoices SET emailed_at = ? WHERE id = ?", s.iso(), r.id);
        event(r.id, SYSTEM.name, "emailed", to);
        count(counters.emails, "sent");
        emailTries.delete(r.id);
      } catch (err) {
        emailTries.set(r.id, { n: tries.n + 1, next: clock() + backoff(tries.n + 1) });
        event(r.id, SYSTEM.name, "email failed", (err as Error).message);
        count(counters.emails, "failed");
      }
    }
  }

  async function emailNow(who: Actor, id: string, v: unknown) {
    const b = body(v ?? {}, ["to", "kind"]);
    const r = invoiceRow(id);
    if (!OWED.includes(r.status) && r.status !== "rejected") throw conflict("Only an issued invoice is emailed; a draft is not an invoice yet.");
    const to = optEmail(b.to, "to") ?? emailOf(r);
    if (!to) throw bad("The customer has no email; give to.");
    const kind = b.kind ?? "issued";
    if (kind !== "issued" && kind !== "reminder") throw bad("kind is issued (the invoice) or reminder.");
    try {
      await mailInvoice(r, to, kind);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(502, "link-failed", `The mail server refused it: ${(err as Error).message}`);
    }
    if (kind === "issued") s.run("UPDATE invoices SET emailed_at = ? WHERE id = ?", s.iso(), r.id);
    event(r.id, who.name, kind === "issued" ? "emailed" : "reminded", to);
    return getInvoice(r.id);
  }

  // ---- Payments ----

  const paymentOut = (p: Record<string, unknown>) => ({
    id: p.id,
    invoice: p.invoice_id,
    date: p.date,
    amount: p.amount,
    method: p.method,
    reference: p.reference,
    note: p.note,
    bankLine: p.bank_line_id,
    createdAt: p.created_at,
    createdBy: p.created_by,
  });

  function markPaid(id: string) {
    const b = balanceOf(id);
    const last = s.one<{ d: string | null }>("SELECT MAX(date) AS d FROM payments WHERE invoice_id = ?", id)!.d;
    s.run("UPDATE invoices SET paid_at = ? WHERE id = ?", b <= 0 ? last : null, id);
  }

  function pay(
    who: Actor,
    invoiceId: string,
    f: { date: string; amount: number; method: string; reference: string | null; note: string | null; bankLine: string | null },
  ) {
    const r = invoiceRow(invoiceId);
    if (r.kind !== "invoice" || !OWED.includes(r.status)) throw conflict("A payment is for an issued invoice that was not cancelled or rejected.");
    const balance = balanceOf(r.id);
    if (f.amount > balance) throw conflict(`The payment is more than what is owed: ${formatMoney(balance, r.currency, config().language)}.`);
    const id = randomUUID();
    s.run(
      "INSERT INTO payments (id, invoice_id, date, amount, method, reference, note, bank_line_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      r.id,
      f.date,
      f.amount,
      f.method,
      f.reference,
      f.note,
      f.bankLine,
      s.iso(),
      who.name,
    );
    markPaid(r.id);
    event(r.id, who.name, "payment", `${formatMoney(f.amount, r.currency, config().language)} on ${f.date}`);
    return paymentOut(s.one<Record<string, unknown>>("SELECT * FROM payments WHERE id = ?", id)!);
  }

  function addPayment(who: Actor, invoiceId: string, v: unknown) {
    const b = body(v, ["date", "amount", "method", "reference", "note"]);
    const date = b.date === undefined ? today() : day(b.date, "date");
    const amount = minor(b.amount, "amount");
    if (amount <= 0) throw bad("amount is above 0.");
    const method = b.method ?? "bank";
    if (!["bank", "cash", "card", "other"].includes(method as string)) throw bad("method is bank, cash, card or other.");
    return s.tx(() =>
      pay(who, invoiceId, {
        date,
        amount,
        method: method as string,
        reference: optText(b.reference, "reference", 100) ?? null,
        note: optText(b.note, "note", 500) ?? null,
        bankLine: null,
      }),
    );
  }

  function removePayment(who: Actor, id: string) {
    const p = s.one<{ invoice_id: string; bank_line_id: string | null; amount: number }>("SELECT * FROM payments WHERE id = ?", id);
    if (!p) throw notFound("The payment");
    s.tx(() => {
      s.run("DELETE FROM payments WHERE id = ?", id);
      if (p.bank_line_id) s.run("UPDATE bank_lines SET state = 'unmatched', invoice_id = NULL WHERE id = ?", p.bank_line_id);
      markPaid(p.invoice_id);
      event(p.invoice_id, who.name, "payment removed");
    });
  }

  // ---- Bank statements ----

  const bankLineOut = (l: Record<string, unknown>) => ({
    id: l.id,
    account: l.account,
    date: l.date,
    amount: l.amount,
    currency: l.currency,
    description: l.description,
    reference: l.reference,
    state: l.state,
    invoice: l.invoice_id
      ? { id: l.invoice_id, number: s.one<{ number: string }>("SELECT number FROM invoices WHERE id = ?", l.invoice_id as string)?.number ?? null }
      : null,
  });

  const fold = (x: string) => x.toLocaleLowerCase("tr").replace(/\s+/g, " ");

  /** Finds the invoice a money-in line pays: its number in the text, or the one invoice of that amount whose customer is named. */
  function matchLine(line: { amount: number; currency: string; description: string; reference: string | null }): InvoiceRow | null {
    const textOf = `${line.description} ${line.reference ?? ""}`;
    const owed = s
      .q<InvoiceRow>(`SELECT * FROM invoices WHERE kind = 'invoice' AND status IN (${OWED_SQL}) AND currency = ? ORDER BY issue_date`, line.currency)
      .map((r) => ({ r, balance: balanceOf(r.id) }))
      .filter((x) => x.balance > 0);
    const numbers = new Set(textOf.toUpperCase().match(/[A-Z0-9]{3}20\d{2}\d{9}/g) ?? []);
    const byNumber = owed.filter((x) => numbers.has(x.r.number!));
    if (byNumber.length === 1 && line.amount <= byNumber[0]!.balance) return byNumber[0]!.r;
    if (byNumber.length) return null;
    const t = fold(textOf);
    const named = owed.filter((x) => {
      const buyer = JSON.parse(x.r.buyer ?? "{}") as Partial<Party>;
      return x.balance === line.amount && ((buyer.taxId && t.includes(buyer.taxId)) || (buyer.name && t.includes(fold(buyer.name))));
    });
    return named.length === 1 ? named[0]!.r : null;
  }

  function importStatement(who: Actor, v: unknown) {
    const b = body(v, ["account", "filename", "content"]);
    const c = config();
    const account = c.bank.find((a) => a.id === b.account);
    if (!account) throw bad(`account is one of the file's bank accounts: ${c.bank.map((a) => a.id).join(", ") || "none yet"}.`);
    if (typeof b.content !== "string" || !b.content.trim()) throw bad("content is the statement file's text (CSV or MT940).");
    let lines;
    try {
      lines = parseStatement(b.content, account);
    } catch (err) {
      if (err instanceof StatementError) throw bad(err.message);
      throw err;
    }
    const sid = randomUUID();
    const result = { statement: sid, lines: lines.length, added: 0, duplicates: 0, matched: 0, unmatched: 0, outgoing: 0 };
    s.tx(() => {
      s.run(
        "INSERT INTO bank_statements (id, account, filename, imported_at, imported_by) VALUES (?, ?, ?, ?, ?)",
        sid,
        account.id,
        optText(b.filename, "filename", 200) ?? null,
        s.iso(),
        who.name,
      );
      const seen = new Map<string, number>();
      for (const l of lines) {
        const key = JSON.stringify([l.date, l.amount, l.reference, l.description]);
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        const fp = fingerprint(l, n);
        if (s.one("SELECT 1 FROM bank_lines WHERE account = ? AND fingerprint = ?", account.id, fp)) {
          result.duplicates++;
          continue;
        }
        const id = randomUUID();
        const inv = l.amount > 0 ? matchLine({ ...l, currency: account.currency }) : null;
        const state = l.amount <= 0 ? "outgoing" : inv ? "matched" : "unmatched";
        s.run(
          "INSERT INTO bank_lines (id, statement_id, account, date, amount, currency, description, reference, fingerprint, state, invoice_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          sid,
          account.id,
          l.date,
          l.amount,
          account.currency,
          l.description.slice(0, 500),
          l.reference,
          fp,
          state,
          inv?.id ?? null,
        );
        result.added++;
        if (inv) {
          pay(who, inv.id, {
            date: l.date,
            amount: l.amount,
            method: "bank",
            reference: l.reference,
            note: `${account.name}: ${l.description}`.slice(0, 500),
            bankLine: id,
          });
          result.matched++;
        } else if (state === "unmatched") result.unmatched++;
        else result.outgoing++;
      }
    });
    return result;
  }

  function listBankLines(p: URLSearchParams) {
    const state = p.get("state") ?? "unmatched";
    if (!["matched", "unmatched", "ignored", "outgoing", "all"].includes(state)) throw bad("state is unmatched, matched, ignored, outgoing or all.");
    return s
      .q<Record<string, unknown>>(
        `SELECT * FROM bank_lines ${state === "all" ? "" : "WHERE state = ?"} ORDER BY date DESC LIMIT 1000`,
        ...(state === "all" ? [] : [state]),
      )
      .map(bankLineOut);
  }

  function resolveBankLine(who: Actor, id: string, v: unknown) {
    const b = body(v, ["invoice", "ignore"]);
    const l = s.one<{
      id: string;
      state: string;
      amount: number;
      date: string;
      reference: string | null;
      description: string;
      account: string;
      currency: string;
    }>("SELECT * FROM bank_lines WHERE id = ?", id);
    if (!l) throw notFound("The bank line");
    if (l.state === "matched") throw conflict("The line pays an invoice already; remove that payment first.");
    s.tx(() => {
      if (b.ignore === true) s.run("UPDATE bank_lines SET state = 'ignored' WHERE id = ?", id);
      else {
        if (l.amount <= 0) throw bad("Money that went out pays no invoice.");
        const r = invoiceRow(text(b.invoice, "invoice", 100));
        if (r.currency !== l.currency) throw bad(`The invoice is in ${r.currency}, the line in ${l.currency}.`);
        pay(who, r.id, { date: l.date, amount: l.amount, method: "bank", reference: l.reference, note: l.description, bankLine: l.id });
        s.run("UPDATE bank_lines SET state = 'matched', invoice_id = ? WHERE id = ?", r.id, id);
      }
    });
    return bankLineOut(s.one<Record<string, unknown>>("SELECT * FROM bank_lines WHERE id = ?", id)!);
  }

  // ---- Recurring invoices ----

  const recurringOut = (t: Record<string, unknown>) => ({
    id: t.id,
    name: t.name,
    customer: t.customer_id,
    currency: t.currency,
    lines: JSON.parse(t.lines as string) as unknown[],
    notes: t.notes,
    everyMonths: t.every_months,
    dayOfMonth: t.day_of_month,
    start: t.start_date,
    end: t.end_date,
    next: t.next_date,
    mode: t.mode,
    active: !!t.active,
    made: t.made,
    lastInvoice: t.last_invoice_id,
    lastError: t.last_error,
    createdAt: t.created_at,
    createdBy: t.created_by,
  });

  function readRecurring(v: unknown, current: Record<string, unknown> | null) {
    const b = body(v, ["name", "customer", "currency", "lines", "notes", "everyMonths", "start", "end", "mode", "active"]);
    const f: Row = {};
    if (!current || b.name !== undefined) f.name = text(b.name, "name", 120);
    if (!current || b.customer !== undefined) f.customer_id = findCustomer(b.customer, "customer").id;
    const customer = customerRow((f.customer_id ?? current!.customer_id) as string);
    const currency = b.currency !== undefined ? String(b.currency) : ((current?.currency as string | undefined) ?? customer.currency ?? config().currency);
    if (!/^[A-Z]{3}$/.test(currency)) throw bad("currency is a three-letter code.");
    f.currency = currency;
    if (!current || b.lines !== undefined) {
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw bad("lines is a list of 1 to 100 lines, as an invoice takes them.");
      b.lines.forEach((l, i) => readLine(l, `lines[${i}]`, currency));
      f.lines = JSON.stringify(b.lines);
    }
    if (b.notes !== undefined) f.notes = optText(b.notes, "notes", 2000) ?? null;
    if (!current || b.everyMonths !== undefined) f.every_months = b.everyMonths === undefined ? 1 : int(b.everyMonths, "everyMonths", 1, 36);
    if (!current || b.start !== undefined) {
      const start = b.start === undefined ? today() : day(b.start, "start");
      f.start_date = start;
      f.day_of_month = Number(start.slice(8));
      f.next_date = start;
    }
    if (b.end !== undefined) f.end_date = optDay(b.end, "end") ?? null;
    if (b.mode !== undefined || !current) {
      const mode = b.mode ?? "issue";
      if (mode !== "issue" && mode !== "draft") throw bad("mode is issue (each one is issued on its day) or draft (it waits for you).");
      f.mode = mode;
    }
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") throw bad("active is true or false.");
      f.active = b.active ? 1 : 0;
    }
    return f;
  }

  function createRecurring(who: Actor, v: unknown) {
    const f = readRecurring(v, null);
    const id = randomUUID();
    const now = s.iso();
    const cols = { id, ...f, created_at: now, created_by: who.name, updated_at: now };
    s.run(
      `INSERT INTO recurring (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols)
        .map(() => "?")
        .join(", ")})`,
      ...Object.values(cols),
    );
    return recurringOut(s.one<Record<string, unknown>>("SELECT * FROM recurring WHERE id = ?", id)!);
  }
  const recurringRow = (id: string) => {
    const t = s.one<Record<string, unknown>>("SELECT * FROM recurring WHERE id = ?", id);
    if (!t) throw notFound("The recurring invoice");
    return t;
  };
  function updateRecurring(_who: Actor, id: string, v: unknown) {
    const t = recurringRow(id);
    const f = readRecurring(v, t);
    if (Object.keys(f).length)
      s.run(
        `UPDATE recurring SET ${Object.keys(f)
          .map((k) => `${k} = ?`)
          .join(", ")}, updated_at = ? WHERE id = ?`,
        ...Object.values(f),
        s.iso(),
        id,
      );
    return recurringOut(recurringRow(id));
  }
  function removeRecurring(_who: Actor, id: string) {
    recurringRow(id);
    s.run("DELETE FROM recurring WHERE id = ?", id);
  }

  /** Makes each recurring invoice whose day has come, once per day: source_ref recurring:<id>:<day> cannot repeat. */
  async function runRecurring() {
    const t0 = today();
    for (const t of s.q<Record<string, unknown>>(
      "SELECT * FROM recurring WHERE active = 1 AND next_date IS NOT NULL AND next_date <= ? ORDER BY next_date",
      t0,
    )) {
      const on = t.next_date as string;
      const next = addMonths(t.start_date as string, (t.every_months as number) * ((t.made as number) + 1), t.day_of_month as number);
      const end = addDays(next, -1);
      const ref = `recurring:${t.id as string}:${on}`;
      let invoiceId = s.one<{ id: string }>("SELECT id FROM invoices WHERE source_ref = ?", ref)?.id ?? null;
      try {
        if (!invoiceId) {
          const inv = createInvoice(
            { ...SYSTEM, name: `Recurring: ${t.name as string}` },
            { customer: t.customer_id, currency: t.currency, lines: JSON.parse(t.lines as string), notes: t.notes ?? undefined, period: { start: on, end } },
            "recurring",
            ref,
          );
          invoiceId = inv.id;
        }
        const finished = t.end_date && next > (t.end_date as string);
        s.run(
          "UPDATE recurring SET made = made + 1, next_date = ?, active = ?, last_invoice_id = ?, last_error = NULL, updated_at = ? WHERE id = ?",
          finished ? null : next,
          finished ? 0 : 1,
          invoiceId,
          s.iso(),
          t.id as string,
        );
        if (t.mode === "issue") await issue({ ...SYSTEM, name: `Recurring: ${t.name as string}` }, invoiceId, {});
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        // The draft stays for a person to finish; the template goes on to its next day.
        s.run("UPDATE recurring SET last_error = ? WHERE id = ?", err.message, t.id as string);
        if (invoiceId) event(invoiceId, SYSTEM.name, "not issued", err.message);
        log("warn", "recurring invoice not issued", { recurring: t.id, error: err.message });
      }
    }
  }

  // ---- Reminders ----

  async function runReminders() {
    const c = config();
    if (!mailer || minuteIn(clock(), c.timeZone) < c.reminders.at) return;
    const t0 = today();
    for (const r of s.q<InvoiceRow>(`SELECT * FROM invoices WHERE kind = 'invoice' AND status IN (${OWED_SQL}) AND due_date IS NOT NULL`)) {
      if (balanceOf(r.id) <= 0) continue;
      const to = emailOf(r);
      if (!to) continue;
      const until = daysBetween(t0, r.due_date!);
      // The one reminder that is due today: the closest before the due day, or the latest after it, each sent once.
      const before = c.reminders.before.filter((d) => until >= 0 && until <= d).sort((a, b) => a - b)[0];
      const after = c.reminders.after.filter((d) => -until >= d).sort((a, b) => b - a)[0];
      const pick = until >= 0 ? (before !== undefined ? { kind: "before", days: before } : null) : after !== undefined ? { kind: "after", days: after } : null;
      if (!pick || s.one("SELECT 1 FROM reminders WHERE invoice_id = ? AND kind = ? AND days = ?", r.id, pick.kind, pick.days)) continue;
      // A later reminder sent means the earlier ones are not sent late.
      if (pick.kind === "after" && s.one("SELECT 1 FROM reminders WHERE invoice_id = ? AND kind = 'after' AND days > ?", r.id, pick.days)) continue;
      let error: string | null = null;
      try {
        await mailInvoice(r, to, "reminder", pick.kind === "before" ? -1 : 1);
        count(counters.reminders, "sent");
      } catch (err) {
        error = (err as Error).message;
        count(counters.reminders, "failed");
      }
      s.run("INSERT INTO reminders (invoice_id, kind, days, sent_at, error) VALUES (?, ?, ?, ?, ?)", r.id, pick.kind, pick.days, s.iso(), error);
      event(r.id, SYSTEM.name, error ? "reminder failed" : "reminded", error ?? `${pick.days} days ${pick.kind} the due day, to ${to}`);
    }
  }

  // ---- CRM ----

  /** A draft from a CRM deal, once per deal: its accepted quote's lines, else the deal's name and value. */
  async function fromDeal(who: Actor, dealId: string) {
    const link = crm;
    if (!link) throw new AppError(409, "not-linked", "No crm in the file.");
    const ref = `crm:${dealId}`;
    const existing = s.one<{ id: string }>("SELECT id FROM invoices WHERE source_ref = ?", ref);
    if (existing) return { invoice: getInvoice(existing.id), created: false };
    let deal;
    try {
      deal = await link.deal(dealId);
    } catch (err) {
      if (err instanceof LinkError) throw new AppError(502, "link-failed", err.message);
      throw err;
    }
    if (!deal) throw new AppError(404, "not-found", "CRM has no such deal.");
    if (deal.status !== "won") throw conflict("The deal is not won in CRM.");
    let customer =
      (deal.company && s.one<CustomerRow>("SELECT * FROM customers WHERE crm_company_id = ?", deal.company.id)) ||
      (deal.contact?.email && s.one<CustomerRow>("SELECT * FROM customers WHERE email = ? ORDER BY created_at LIMIT 1", deal.contact.email.toLowerCase())) ||
      null;
    if (!customer) {
      // CRM keeps no tax number or address; the customer is made with what it has, to be completed before issuing.
      const c = createCustomer(who, {
        name: deal.company?.name || deal.contact?.name || deal.name,
        address: { city: deal.company?.city ?? "Belirtilmedi" },
        email: deal.contact?.email ?? null,
        crmCompany: deal.company?.id ?? null,
      });
      customer = customerRow(c.id);
    }
    const c = config();
    const vat = deal.quote && c.tax.kdvRates.includes(Math.round(deal.quote.vat)) ? Math.round(deal.quote.vat) : 20;
    const lines = deal.quote?.lines.length
      ? deal.quote.lines.map((l) => ({
          name: l.item,
          quantity: Math.round(l.quantity * 1000) / 1000,
          unitPrice: Math.round(l.unitPrice * 100),
          discount: Math.round(l.discount * 100) / 100,
          kdvRate: vat,
          ...(vat === 0 ? { exemption: "351" } : {}),
        }))
      : [{ name: deal.name, quantity: 1, unitPrice: Math.round(deal.value * 100), kdvRate: vat }];
    const inv = createInvoice(
      who,
      { customer: customer.id, currency: deal.currency, lines, orderRef: deal.quote?.number || null, notes: `CRM: ${deal.name}` },
      "crm",
      ref,
    );
    return { invoice: inv, created: true };
  }

  async function runCrm() {
    const link = crm;
    if (!link || config().crm?.wonDeals !== "draft") return;
    // Deals won before the link was set up are not drafted on their own; POST /api/v1/crm/deals/{id} drafts one.
    let since = s.one<{ value: string }>("SELECT value FROM settings WHERE key = 'crm_since'")?.value;
    if (!since) {
      since = s.iso();
      s.run("INSERT INTO settings (key, value) VALUES ('crm_since', ?)", since);
    }
    try {
      for (const d of await link.wonDeals()) {
        if (!d.closedAt || d.closedAt < since || s.one("SELECT 1 FROM invoices WHERE source_ref = ?", `crm:${d.id}`)) continue;
        await fromDeal({ ...SYSTEM, name: "CRM" }, d.id);
      }
    } catch (err) {
      if (!(err instanceof LinkError) && !(err instanceof AppError)) throw err;
      log("warn", "won deals not read from CRM", { error: err.message });
    }
  }

  // ---- What other products call ----

  const billableOut = (it: Record<string, unknown>) => ({
    id: it.id,
    externalId: it.external_id,
    source: it.source,
    customer: it.customer_id,
    date: it.date,
    description: it.description,
    quantity: (it.quantity as number) / 1000,
    unit: it.unit,
    unitPrice: it.unit_price,
    currency: it.currency,
    kdvRate: it.kdv_rate,
    invoice: it.invoice_id ?? null,
  });

  /** Time sends approved billable hours; each waits for an invoice. The same external_id is taken once. */
  function addBillable(_who: Actor, v: unknown) {
    const b = body(v, ["items"]);
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 1000) throw bad("items is a list of 1 to 1000 billable items.");
    const c = config();
    const result = { added: 0, existing: 0, items: [] as string[] };
    const rows = b.items.map((x, i) => {
      const at = `items[${i}]`;
      if (!isObj(x)) throw bad(`${at} is { external_id, customer, date, description, quantity, unit, unitPrice, currency, kdvRate }.`);
      body(x, ["external_id", "source", "customer", "date", "description", "quantity", "unit", "unitPrice", "currency", "kdvRate"]);
      const unit = x.unit ?? "HUR";
      if (typeof unit !== "string" || !UNITS[unit]) throw bad(`${at}.unit is one of ${Object.keys(UNITS).join(", ")}.`);
      const kdvRate = x.kdvRate === undefined ? 20 : int(x.kdvRate, `${at}.kdvRate`, 0, 100);
      if (!c.tax.kdvRates.includes(kdvRate) || kdvRate === 0) throw bad(`${at}.kdvRate is one of ${c.tax.kdvRates.filter((r) => r > 0).join(", ")}.`);
      const currency = x.currency === undefined ? c.currency : String(x.currency);
      if (!/^[A-Z]{3}$/.test(currency)) throw bad(`${at}.currency is a three-letter code.`);
      return {
        external_id: text(x.external_id, `${at}.external_id`, 100),
        source: x.source === undefined ? "time" : text(x.source, `${at}.source`, 40),
        customer_id: findCustomer(x.customer, `${at}.customer`).id,
        date: day(x.date, `${at}.date`),
        description: text(x.description, `${at}.description`, 300),
        quantity: quantity(x.quantity, `${at}.quantity`),
        unit,
        unit_price: minor(x.unitPrice, `${at}.unitPrice`),
        currency,
        kdv_rate: kdvRate,
      };
    });
    s.tx(() => {
      for (const r of rows) {
        const had = s.one<{ id: string }>("SELECT id FROM billable_items WHERE external_id = ?", r.external_id);
        if (had) {
          result.existing++;
          result.items.push(had.id);
          continue;
        }
        const id = randomUUID();
        const cols = { id, ...r, created_at: s.iso() };
        s.run(
          `INSERT INTO billable_items (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols)
            .map(() => "?")
            .join(", ")})`,
          ...Object.values(cols),
        );
        result.added++;
        result.items.push(id);
      }
    });
    return result;
  }

  function listBillable(p: URLSearchParams) {
    const customer = p.get("customer");
    const open = p.get("open") !== "false";
    return s
      .q<Record<string, unknown>>(
        `SELECT * FROM billable_items WHERE (? IS NULL OR customer_id = ?) ${open ? "AND invoice_id IS NULL" : ""} ORDER BY date LIMIT 2000`,
        customer,
        customer,
      )
      .map(billableOut);
  }

  /** Inventory reads goods that left and came back, after the last seq it has. */
  function stockMovements(p: URLSearchParams) {
    const after = Number(p.get("after") ?? 0);
    const limit = Math.min(1000, Math.max(1, Number(p.get("limit") ?? 500)));
    if (!Number.isInteger(after) || after < 0) throw bad("after is the last seq read, 0 for the first.");
    const rows = s.q<{
      seq: number;
      invoice_id: string;
      number: string;
      product_id: string | null;
      code: string;
      quantity: number;
      unit: string;
      date: string;
      at: string;
    }>("SELECT * FROM stock_movements WHERE seq > ? ORDER BY seq LIMIT ?", after, limit);
    return {
      movements: rows.map((m) => ({
        seq: m.seq,
        invoice: m.invoice_id,
        number: m.number,
        product: m.product_id,
        code: m.code,
        quantity: m.quantity / 1000,
        unit: m.unit,
        date: m.date,
        at: m.at,
      })),
      next: rows.at(-1)?.seq ?? after,
    };
  }

  /** Helpdesk: the customer with exactly this email, or the invoice with this number, and what they owe. */
  function lookup(p: URLSearchParams) {
    const email = p.get("email")?.trim().toLowerCase();
    const number = p.get("number")?.trim().toUpperCase();
    if (!email && !number) throw bad("Give email or number.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("email is an email address.");
    let customer: CustomerRow | undefined;
    if (number) {
      const inv = s.one<{ customer_id: string }>("SELECT customer_id FROM invoices WHERE number = ?", number);
      customer = inv ? s.one<CustomerRow>("SELECT * FROM customers WHERE id = ?", inv.customer_id) : undefined;
    } else customer = s.one<CustomerRow>("SELECT * FROM customers WHERE email = ? ORDER BY created_at LIMIT 1", email!);
    if (!customer) throw notFound("No customer or invoice matches; it");
    const invoices = s
      .q<InvoiceRow>(
        "SELECT * FROM invoices WHERE customer_id = ? AND number IS NOT NULL ORDER BY (number = ?) DESC, issue_date DESC LIMIT 10",
        customer.id,
        number ?? "",
      )
      .map(invoiceOut)
      .map((i) => ({
        id: i.id,
        number: i.number!,
        kind: i.kind,
        date: i.issueDate!,
        due: i.dueDate,
        currency: i.currency,
        payable: i.totals.payable,
        balance: i.balance,
        status: i.status,
        overdue: i.overdue,
        url: i.url,
      }));
    return {
      customer: { id: customer.id, name: customer.name, email: customer.email, taxId: customer.tax_id || null, url: `${publicUrl}/customers/${customer.id}` },
      owed: balances(customer.id),
      invoices,
    };
  }

  /**
   * Audience: delete a person on request (KVKK). Issued invoices are kept for ten years (VUK 253, TTK 82), so a customer
   * with any keeps them, and only what is not on an invoice goes. While one is unpaid the answer is waiting.
   */
  function erase(v: unknown) {
    const b = body(v, ["reference", "product", "people"]);
    const reference = text(b.reference, "reference", 120);
    const done = s.one<{ status: string; deleted: number; detail: string | null }>("SELECT * FROM erasures WHERE reference = ?", reference);
    if (done?.status === "done") return { status: 200, body: { status: "done", deleted: done.deleted, ...(done.detail ? { detail: done.detail } : {}) } };
    if (!isObj(b.people)) throw bad("people is { emails, phones, userIds }.");
    const emails = (Array.isArray(b.people.emails) ? b.people.emails : []).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase());
    const phones = (Array.isArray(b.people.phones) ? b.people.phones : []).filter((x): x is string => typeof x === "string").map((x) => x.replace(/\D/g, ""));
    const all = s.q<CustomerRow>("SELECT * FROM customers");
    const hits = all.filter((c) => (c.email && emails.includes(c.email)) || (c.phone && phones.length && phones.includes(c.phone.replace(/\D/g, ""))));
    const unpaid = hits.flatMap((c) =>
      s
        .q<{ id: string }>(`SELECT id FROM invoices WHERE customer_id = ? AND kind = 'invoice' AND status IN (${OWED_SQL})`, c.id)
        .filter((i) => balanceOf(i.id) > 0),
    );
    if (unpaid.length) {
      const detail = `${unpaid.length} invoice${unpaid.length > 1 ? "s are" : " is"} not yet paid.`;
      s.run("INSERT OR REPLACE INTO erasures (reference, at, status, deleted, detail) VALUES (?, ?, 'waiting', 0, ?)", reference, s.iso(), detail);
      return { status: 202, body: { status: "waiting", detail } };
    }
    let deleted = 0;
    let kept = 0;
    s.tx(() => {
      for (const c of hits) {
        const issued = s.one<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND number IS NOT NULL", c.id)!.n;
        if (issued) {
          s.run("UPDATE customers SET email = NULL, phone = NULL, notes = NULL, updated_at = ? WHERE id = ?", s.iso(), c.id);
          s.run("UPDATE invoices SET email_to = NULL WHERE customer_id = ?", c.id);
          kept += issued;
        } else removeCustomer(SYSTEM, c.id);
        deleted++;
      }
      const detail = kept
        ? `${kept} issued invoice${kept > 1 ? "s are" : " is"} kept for ten years, as VUK 253 and TTK 82 ask; the email and phone were removed.`
        : null;
      s.run("INSERT OR REPLACE INTO erasures (reference, at, status, deleted, detail) VALUES (?, ?, 'done', ?, ?)", reference, s.iso(), deleted, detail);
    });
    const detail = s.one<{ detail: string | null }>("SELECT detail FROM erasures WHERE reference = ?", reference)!.detail;
    return { status: 200, body: { status: "done", deleted, ...(detail ? { detail } : {}) } };
  }

  // ---- Exports for the accountant ----

  function range(p: URLSearchParams) {
    const from = p.get("from") ?? `${today().slice(0, 7)}-01`;
    const to = p.get("to") ?? today();
    if (!isDay(from) || !isDay(to)) throw bad("from and to are days, YYYY-MM-DD.");
    return { from, to };
  }

  function exportInvoices(p: URLSearchParams) {
    const { from, to } = range(p);
    const c = config();
    const rates = c.tax.kdvRates;
    const rows = s.q<InvoiceRow>("SELECT * FROM invoices WHERE number IS NOT NULL AND issue_date BETWEEN ? AND ? ORDER BY series, year, seq", from, to);
    const header = [
      "Belge",
      "Fatura no",
      "ETTN",
      "Senaryo",
      "Tip",
      "Durum",
      "Tarih",
      "Vade",
      "Müşteri",
      "VKN/TCKN",
      "Vergi dairesi",
      "İade edilen fatura",
      "Para birimi",
      "Kur",
      "Matrah",
      ...rates.flatMap((r) => [`KDV %${r} matrah`, `KDV %${r}`]),
      "KDV toplam",
      "Tevkifat",
      "Tevkifat kodları",
      "İstisna kodları",
      "Vergiler dahil",
      "Ödenecek",
      "TL matrah",
      "TL KDV",
      "TL tevkifat",
      "TL ödenecek",
      "Ödenen",
      "Kalan",
    ];
    const out = rows.map((r) => {
      const t = invoiceTotals(linesOf(r.id).map(lineInput));
      const buyer = JSON.parse(r.buyer ?? "{}") as Party;
      const original = r.original_id ? s.one<{ number: string }>("SELECT number FROM invoices WHERE id = ?", r.original_id)?.number : null;
      const kdvAt = (rate: number) => t.kdvBreakdown.filter((k) => k.rate === rate);
      return [
        r.kind === "credit_note" ? "İade" : "Fatura",
        r.number,
        r.uuid,
        r.profile,
        r.type_code,
        r.status,
        r.issue_date,
        r.due_date,
        buyer.name ?? "",
        buyer.taxId ?? "",
        buyer.taxOffice ?? "",
        original ?? "",
        r.currency,
        r.rate === null ? "" : rate4(r.rate).replace(".", ","),
        decimal(t.net),
        ...rates.flatMap((rate) => [decimal(kdvAt(rate).reduce((x, k) => x + k.base, 0)), decimal(kdvAt(rate).reduce((x, k) => x + k.amount, 0))]),
        decimal(t.kdv),
        decimal(t.withheld),
        t.withholdingBreakdown.map((w) => `${w.code} ${w.tenths}/10`).join(" "),
        [...new Set(t.kdvBreakdown.map((k) => k.exemption).filter(Boolean))].join(" "),
        decimal(t.total),
        decimal(t.payable),
        decimal(toTry(t.net, r.rate)),
        decimal(toTry(t.kdv, r.rate)),
        decimal(toTry(t.withheld, r.rate)),
        decimal(toTry(t.payable, r.rate)),
        decimal(r.kind === "invoice" ? paidOf(r.id) : 0),
        decimal(r.kind === "invoice" ? balanceOf(r.id) : 0),
      ];
    });
    return { body: csv(header, out), filename: `faturalar-${from}-${to}.csv` };
  }

  function exportPayments(p: URLSearchParams) {
    const { from, to } = range(p);
    const rows = s.q<Record<string, string | number | null>>(
      `SELECT p.date, i.number, i.currency, p.amount, p.method, p.reference, p.note, i.buyer FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE p.date BETWEEN ? AND ? ORDER BY p.date, i.number`,
      from,
      to,
    );
    return {
      body: csv(
        ["Tarih", "Fatura no", "Müşteri", "VKN/TCKN", "Para birimi", "Tutar", "Yöntem", "Referans", "Not"],
        rows.map((r) => {
          const buyer = JSON.parse((r.buyer as string) ?? "{}") as Party;
          return [r.date, r.number, buyer.name ?? "", buyer.taxId ?? "", r.currency, decimal(r.amount as number), r.method, r.reference, r.note];
        }),
      ),
      filename: `tahsilatlar-${from}-${to}.csv`,
    };
  }

  function exportUbl(p: URLSearchParams) {
    const { from, to } = range(p);
    const rows = s.q<{ number: string; xml: string; issued_at: string }>(
      `SELECT number, xml, issued_at FROM invoices WHERE xml IS NOT NULL AND status NOT IN ('refused', 'failed') AND issue_date BETWEEN ? AND ? ORDER BY number`,
      from,
      to,
    );
    return {
      body: zip(rows.map((r) => ({ name: `${r.number}.xml`, data: Buffer.from(r.xml), date: new Date(r.issued_at) }))),
      filename: `ubl-${from}-${to}.zip`,
    };
  }

  // ---- Overview, settings, the background ----

  function summary() {
    const t0 = today();
    const owed = new Map<string, { currency: string; owed: number; overdue: number; invoices: number; overdueInvoices: number }>();
    const byCustomer = new Map<string, { customer: { id: string; name: string }; currency: string; owed: number; overdue: number }>();
    for (const r of s.q<InvoiceRow>(`SELECT * FROM invoices WHERE kind = 'invoice' AND status IN (${OWED_SQL})`)) {
      const b = balanceOf(r.id);
      if (b <= 0) continue;
      const late = !!r.due_date && r.due_date < t0;
      const o = owed.get(r.currency) ?? { currency: r.currency, owed: 0, overdue: 0, invoices: 0, overdueInvoices: 0 };
      o.owed += b;
      o.invoices++;
      if (late) ((o.overdue += b), o.overdueInvoices++);
      owed.set(r.currency, o);
      const key = `${r.customer_id}|${r.currency}`;
      const name = (JSON.parse(r.buyer ?? "{}") as Party).name ?? "";
      const k = byCustomer.get(key) ?? { customer: { id: r.customer_id, name }, currency: r.currency, owed: 0, overdue: 0 };
      k.owed += b;
      if (late) k.overdue += b;
      byCustomer.set(key, k);
    }
    const n = (sql: string) => s.one<{ n: number }>(sql)!.n;
    return {
      owed: [...owed.values()],
      customers: [...byCustomer.values()].sort((a, b) => b.overdue - a.overdue || b.owed - a.owed).slice(0, 20),
      drafts: n("SELECT COUNT(*) AS n FROM invoices WHERE status = 'draft'"),
      sending: n("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('queued', 'waiting')"),
      refused: n("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('refused', 'failed')"),
      unmatchedBankLines: n("SELECT COUNT(*) AS n FROM bank_lines WHERE state = 'unmatched'"),
      openBillableItems: n("SELECT COUNT(*) AS n FROM billable_items WHERE invoice_id IS NULL"),
    };
  }

  function settings() {
    const c = config();
    return {
      timeZone: c.timeZone,
      currency: c.currency,
      language: c.language,
      seller: c.seller,
      sellerSet: !isDefaultSeller(c),
      series: c.series,
      paymentDays: c.paymentDays,
      kdvRates: c.tax.kdvRates,
      withholding: [...c.tax.withholding.values()].map((w) => ({ code: w.code, name: w.name, share: `${w.tenths}/10` })),
      exemptions: [...c.tax.exemptions.values()],
      units: Object.entries(UNITS).map(([code, n]) => ({ code, name: n[c.language] })),
      integrator: c.integrator
        ? {
            provider: c.integrator.provider,
            url: c.integrator.url,
            profile: c.integrator.profile,
            keySet: c.integrator.provider === "fake" || !!env[c.integrator.apiKey],
          }
        : null,
      exchangeRates: c.exchangeRates,
      reminders: {
        before: c.reminders.before,
        after: c.reminders.after,
        at: `${String(Math.floor(c.reminders.at / 60)).padStart(2, "0")}:${String(c.reminders.at % 60).padStart(2, "0")}`,
      },
      emailOnIssue: c.emailOnIssue,
      mail: c.mail ? { host: c.mail.host, port: c.mail.port, from: c.mail.from } : null,
      bank: c.bank.map((a) => ({ id: a.id, name: a.name, iban: a.iban, currency: a.currency, format: a.format })),
      crm: c.crm ? { url: c.crm.url, wonDeals: c.crm.wonDeals } : null,
      file: opts.fileState?.() ?? null,
      text: cfgText,
    };
  }

  function setConfig(c: Config, raw: string): string[] {
    const warnings = configWarnings(c, env);
    cfg = c;
    cfgText = raw;
    mailer?.close();
    mailer = opts.mailer ? opts.mailer(c) : null;
    integrator = opts.integrator ? opts.integrator(c) : null;
    rates = opts.rates ? opts.rates(c) : tcmb({ url: c.exchangeRates.url });
    crm = opts.crm ? opts.crm(c) : c.crm ? crmLink({ url: c.crm.url, token: env[c.crm.token] }) : null;
    return warnings;
  }

  let lastCrm = 0;
  let ticking = false;
  async function tick() {
    if (!cfg || ticking) return;
    ticking = true;
    try {
      await deliver();
      await runRecurring();
      await runReminders();
      if (cfg.crm && clock() - lastCrm >= cfg.crm.everyMinutes * 60_000) {
        lastCrm = clock();
        await runCrm();
      }
    } catch (err) {
      log("error", "background work failed", { error: String(err) });
    } finally {
      ticking = false;
    }
  }

  function gauges() {
    const byStatus = Object.fromEntries(
      s.q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM invoices GROUP BY status").map((r) => [r.status, r.n]),
    );
    return { byStatus, counters, unmatched: s.one<{ n: number }>("SELECT COUNT(*) AS n FROM bank_lines WHERE state = 'unmatched'")!.n };
  }

  return {
    store: s,
    config: () => cfg,
    setConfig,
    settings,
    summary,
    gauges,
    tick,
    deliver,
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    removeCustomer,
    checkCustomer,
    listProducts,
    createProduct,
    updateProduct,
    removeProduct,
    listInvoices,
    getInvoice,
    createInvoice: (who: Actor, v: unknown) => createInvoice(who, v),
    updateInvoice,
    removeInvoice,
    issue,
    creditNote,
    cancel,
    invoiceFile,
    invoiceXml,
    emailNow,
    addPayment,
    removePayment,
    importStatement,
    listBankLines,
    resolveBankLine,
    listRecurring: () => s.q<Record<string, unknown>>("SELECT * FROM recurring ORDER BY name").map(recurringOut),
    getRecurring: (id: string) => recurringOut(recurringRow(id)),
    createRecurring,
    updateRecurring,
    removeRecurring,
    runRecurring,
    runReminders,
    runCrm,
    fromDeal,
    getRate,
    addBillable,
    listBillable,
    stockMovements,
    lookup,
    erase,
    exportInvoices,
    exportPayments,
    exportUbl,
    amt,
    qty,
  };
}

export type Invoices = ReturnType<typeof createInvoices>;
