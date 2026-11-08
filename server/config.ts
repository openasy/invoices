// Invoices' settings, from one YAML file (INVOICES_CONFIG): the seller, the number series, the KDV rates, withholding
// and exemption codes, the GİB integrator and its account, exchange rates, payment terms and reminders, the mail
// server, the bank accounts statements are imported for, and the links to CRM. As in the other products, the file is
// the only way in: no screen or API route changes these. It is applied whole or not at all, read again within a minute
// of a change, and a file with a mistake leaves the last good version in place. Customers, products, invoices and
// payments are kept in the database.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { EXEMPTIONS, KDV_RATES, WITHHOLDING, taxIdKind, type Exemption, type TaxTables, type Withholding } from "./tax.ts";

export type Language = "tr" | "en";
export type RateKind = "forex_buying" | "forex_selling" | "banknote_buying" | "banknote_selling";
export type BankFormat = "csv" | "mt940";

export interface Address {
  street: string | null;
  district: string | null;
  city: string;
  postalCode: string | null;
  country: string;
}

export interface Seller {
  name: string;
  taxId: string;
  taxOffice: string;
  address: Address;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** Ticaret sicil numarası and MERSİS numarası, printed when set. */
  tradeRegistry: string | null;
  mersis: string | null;
  /** Where customers pay, printed on the PDF and in reminders. */
  iban: string | null;
  bank: string | null;
}

export interface BankAccount {
  id: string;
  name: string;
  iban: string | null;
  currency: string;
  format: BankFormat;
  /** For csv: the header of each column, the separator, and how dates and amounts are written. */
  csv: {
    date: string;
    amount: string | null;
    credit: string | null;
    debit: string | null;
    description: string;
    reference: string | null;
    separator: ";" | "," | "\t";
    dateFormat: "DD.MM.YYYY" | "YYYY-MM-DD" | "DD/MM/YYYY";
    decimal: "," | ".";
  };
}

export interface Integrator {
  provider: "nilvera" | "fake";
  url: string;
  /** The variable that holds the API key, never the key itself. */
  apiKey: string;
  /** e-Fatura profile: TEMELFATURA cannot be refused by the buyer; TICARIFATURA can, within 8 days. */
  profile: "TEMELFATURA" | "TICARIFATURA";
  /** How often status is asked for while an invoice is on its way. */
  pollMinutes: number;
}

export interface Config {
  timeZone: string;
  /** The currency invoices are in unless the customer or the invoice says otherwise. */
  currency: string;
  language: Language;
  seller: Seller;
  series: { eFatura: string; eArsiv: string };
  paymentDays: number;
  tax: TaxTables;
  integrator: Integrator | null;
  exchangeRates: { url: string; rate: RateKind };
  reminders: { before: number[]; after: number[]; at: number };
  /** Sent with the invoice's PDF when it is issued, unless the invoice says not to. */
  emailOnIssue: boolean;
  mail: { host: string; port: number; security: "starttls" | "tls" | "none"; user: string | null; password: string; from: string } | null;
  bank: BankAccount[];
  crm: { url: string; token: string; wonDeals: "draft" | "off"; everyMinutes: number } | null;
  notes: string | null;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOP = [
  "time_zone",
  "currency",
  "language",
  "seller",
  "series",
  "payment_terms",
  "kdv_rates",
  "withholding",
  "exemptions",
  "integrator",
  "exchange_rates",
  "reminders",
  "email_on_issue",
  "mail",
  "bank",
  "crm",
  "notes",
];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if ((typeof v !== "string" && typeof v !== "number") || !String(v).trim() || String(v).length > max)
    throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return String(v).trim();
}

const optText = (v: unknown, at: string, max = 200): string | null => (v === undefined || v === null ? null : text(v, at, max));

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as INVOICES_INTEGRATOR_KEY, never the secret itself.`);
  return v;
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 3d, 30d: a number of days. */
function days(v: unknown, at: string, min = 0, max = 365): number {
  const m = /^(\d{1,3})\s*d$/.exec(String(v ?? "").trim());
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= min && n <= max)) throw new Error(`${at} is a number of days from ${min}d to ${max}d, such as 30d.`);
  return n;
}

function time(v: unknown, at: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? ""));
  if (!m) throw new Error(`${at} is a time such as 09:00.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** An address of another service: https://, or http:// inside the install (localhost, or a host without dots). */
function baseUrl(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const inside = url && (/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && inside)) || url.search || url.hash)
    throw new Error(`${at} is an https:// address, such as https://crm.example.com (http:// only for a host without dots, such as http://crm:8080).`);
  return url.origin + url.pathname.replace(/\/$/, "");
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !EMAIL.test(v.trim()) || v.length > 254) throw new Error(`${at} is an email address.`);
  return v.trim().toLowerCase();
}

function currency(v: unknown, at: string): string {
  const c = String(v ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error(`${at} is a three-letter ISO 4217 code, such as TRY, EUR or USD.`);
  return c;
}

/** A Turkish IBAN: TR, two check digits and 22 more, checked by its mod-97. */
export function validIban(v: string): boolean {
  const s = v.replace(/\s/g, "").toUpperCase();
  if (!/^TR\d{24}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  const digits = [...moved].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join("");
  let r = 0;
  for (const c of digits) r = (r * 10 + Number(c)) % 97;
  return r === 1;
}

function iban(v: unknown, at: string): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s/g, "").toUpperCase();
  if (!validIban(s)) throw new Error(`${at} is a Turkish IBAN, TR and 24 digits, such as TR33 0006 1005 1978 6457 8413 26.`);
  return s;
}

function address(v: unknown, at: string): Address {
  if (!isObj(v)) throw new Error(`${at} is a map with street, district, city, postal_code and country.`);
  keys(v, at, ["street", "district", "city", "postal_code", "country"]);
  return {
    street: optText(v.street, `${at}.street`, 200),
    district: optText(v.district, `${at}.district`, 60),
    city: text(v.city, `${at}.city`, 60),
    postalCode: optText(v.postal_code, `${at}.postal_code`, 10),
    country: v.country === undefined ? "Türkiye" : text(v.country, `${at}.country`, 60),
  };
}

const SERIES = /^[A-Z0-9]{3}$/;

const DEFAULT_SELLER: Seller = {
  name: "Firma Adı A.Ş.",
  taxId: "1234567890",
  taxOffice: "Vergi Dairesi",
  address: { street: null, district: null, city: "İstanbul", postalCode: null, country: "Türkiye" },
  email: null,
  phone: null,
  website: null,
  tradeRegistry: null,
  mersis: null,
  iban: null,
  bank: null,
};

const INTEGRATOR_URLS: Record<Integrator["provider"], string> = { nilvera: "https://api.nilvera.com", fake: "" };

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const timeZone = doc.time_zone === undefined ? "Europe/Istanbul" : text(doc.time_zone, "time_zone", 64);
  if (!validTimeZone(timeZone)) throw new Error(`time_zone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);
  const cur = doc.currency === undefined ? "TRY" : currency(doc.currency, "currency");
  const language = doc.language ?? "tr";
  if (language !== "tr" && language !== "en") throw new Error("language is tr or en: the language of the PDF and of the emails.");

  // The seller: what every invoice says about you.
  let seller = DEFAULT_SELLER;
  if (doc.seller !== undefined && doc.seller !== null) {
    const s = doc.seller;
    const SK = ["name", "tax_id", "tax_office", "address", "email", "phone", "website", "trade_registry", "mersis", "iban", "bank"];
    if (!isObj(s)) throw new Error(`seller is a map with ${SK.join(", ")}.`);
    keys(s, "seller", SK);
    const taxId = text(s.tax_id, "seller.tax_id", 11);
    if (!taxIdKind(taxId)) throw new Error("seller.tax_id is your VKN (10 digits) or, for a sole trader, TCKN (11 digits).");
    const mersis = optText(s.mersis, "seller.mersis", 16);
    if (mersis && !/^\d{16}$/.test(mersis)) throw new Error("seller.mersis is 16 digits.");
    seller = {
      name: text(s.name, "seller.name", 200),
      taxId,
      taxOffice: text(s.tax_office, "seller.tax_office", 80),
      address: address(s.address, "seller.address"),
      email: s.email === undefined || s.email === null ? null : email(s.email, "seller.email"),
      phone: optText(s.phone, "seller.phone", 40),
      website: optText(s.website, "seller.website", 200),
      tradeRegistry: optText(s.trade_registry, "seller.trade_registry", 40),
      mersis,
      iban: iban(s.iban, "seller.iban"),
      bank: optText(s.bank, "seller.bank", 80),
    };
  }

  // Number series: three letters or digits, then the year and nine digits (GİB's 16 characters).
  const sr = doc.series ?? {};
  if (!isObj(sr)) throw new Error("series is a map with e_fatura and e_arsiv, each three letters or digits, such as ABC.");
  keys(sr, "series", ["e_fatura", "e_arsiv"]);
  const series = { eFatura: String(sr.e_fatura ?? "FAT").toUpperCase(), eArsiv: String(sr.e_arsiv ?? "ARS").toUpperCase() };
  for (const [k, v] of Object.entries({ e_fatura: series.eFatura, e_arsiv: series.eArsiv }))
    if (!SERIES.test(v)) throw new Error(`series.${k} is three letters (A to Z, no Turkish letters) or digits, such as ABC.`);
  if (series.eFatura === series.eArsiv) throw new Error("series.e_fatura and series.e_arsiv are different series: each counts on its own.");

  const paymentDays = doc.payment_terms === undefined ? 30 : days(doc.payment_terms, "payment_terms", 0, 365);

  // Taxes.
  let kdvRates = KDV_RATES;
  if (doc.kdv_rates !== undefined) {
    const r = doc.kdv_rates;
    if (!Array.isArray(r) || !r.length || r.some((x) => !Number.isInteger(x) || x < 0 || x > 100))
      throw new Error("kdv_rates is a list of whole percentages from 0 to 100, such as [0, 1, 10, 20].");
    kdvRates = [...new Set(r as number[])].sort((a, b) => a - b);
  }
  const withholding = new Map<string, Withholding>(WITHHOLDING.map((w) => [w.code, w]));
  const wh = doc.withholding ?? {};
  if (!isObj(wh)) throw new Error('withholding is a map of codes, such as "624": { name: Yük taşımacılığı hizmeti, share: 2/10 }.');
  for (const [code, v] of Object.entries(wh)) {
    const at = `withholding.${code}`;
    if (!/^\d{3}$/.test(code)) throw new Error(`${at}: a withholding code is three digits, such as 624.`);
    if (!isObj(v)) throw new Error(`${at} is a map with name and share.`);
    keys(v, at, ["name", "share"]);
    const m = /^(\d{1,2})\s*\/\s*10$/.exec(String(v.share ?? ""));
    const tenths = m ? Number(m[1]) : NaN;
    if (!(tenths >= 1 && tenths <= 10)) throw new Error(`${at}.share is a share in tenths, such as 2/10 or 9/10.`);
    withholding.set(code, { code, name: v.name === undefined ? (withholding.get(code)?.name ?? code) : text(v.name, `${at}.name`, 200), tenths });
  }
  const exemptions = new Map<string, Exemption>(EXEMPTIONS.map((e) => [e.code, e]));
  const ex = doc.exemptions ?? {};
  if (!isObj(ex)) throw new Error('exemptions is a map of codes to names, such as "350": Diğerleri.');
  for (const [code, v] of Object.entries(ex)) {
    if (!/^\d{3}$/.test(code)) throw new Error(`exemptions.${code}: an exemption code is three digits, such as 301.`);
    exemptions.set(code, { code, name: text(v, `exemptions.${code}`, 200), exempt: code !== "351" });
  }

  // The GİB special integrator.
  let integrator: Integrator | null = null;
  if (doc.integrator !== undefined && doc.integrator !== null) {
    const g = doc.integrator;
    if (!isObj(g)) throw new Error("integrator is a map with provider, url, api_key, profile and poll_every.");
    keys(g, "integrator", ["provider", "url", "api_key", "profile", "poll_every"]);
    const provider = g.provider;
    if (provider !== "nilvera" && provider !== "fake")
      throw new Error(
        "integrator.provider is nilvera, or fake to try Invoices without sending anything to GİB. Only integrators with an API can be connected.",
      );
    const profile = g.profile ?? "TEMELFATURA";
    if (profile !== "TEMELFATURA" && profile !== "TICARIFATURA") throw new Error("integrator.profile is TEMELFATURA or TICARIFATURA.");
    const pm = /^(\d{1,3})\s*m$/.exec(String(g.poll_every ?? "5m"));
    if (!pm || Number(pm[1]) < 1) throw new Error("integrator.poll_every is a number of minutes, such as 5m.");
    integrator = {
      provider,
      url: g.url === undefined ? INTEGRATOR_URLS[provider] : baseUrl(g.url, "integrator.url"),
      apiKey: g.api_key === undefined ? "INVOICES_INTEGRATOR_KEY" : env(g.api_key, "integrator.api_key"),
      profile,
      pollMinutes: Number(pm[1]),
    };
  }

  // Exchange rates: TCMB's indicative rates.
  const xr = doc.exchange_rates ?? {};
  if (!isObj(xr)) throw new Error("exchange_rates is a map with url and rate.");
  keys(xr, "exchange_rates", ["url", "rate"]);
  const rate = xr.rate ?? "forex_buying";
  if (!["forex_buying", "forex_selling", "banknote_buying", "banknote_selling"].includes(rate as string))
    throw new Error("exchange_rates.rate is forex_buying (döviz alış, what VUK asks for), forex_selling, banknote_buying or banknote_selling.");
  const exchangeRates = { url: xr.url === undefined ? "https://www.tcmb.gov.tr/kurlar" : baseUrl(xr.url, "exchange_rates.url"), rate: rate as RateKind };

  // Reminders.
  const rm = doc.reminders ?? {};
  if (!isObj(rm)) throw new Error("reminders is a map with before, after and at.");
  keys(rm, "reminders", ["before", "after", "at"]);
  const list = (v: unknown, at: string, dflt: number[]) => {
    if (v === undefined) return dflt;
    if (!Array.isArray(v) || v.length > 10) throw new Error(`${at} is a list of up to 10 numbers of days, such as [1d, 7d, 30d].`);
    return [...new Set(v.map((x, i) => days(x, `${at}[${i}]`, 1, 365)))].sort((a, b) => a - b);
  };
  const reminders = {
    before: list(rm.before, "reminders.before", [3]),
    after: list(rm.after, "reminders.after", [1, 7, 30]),
    at: time(rm.at ?? "09:00", "reminders.at"),
  };

  if (doc.email_on_issue !== undefined && typeof doc.email_on_issue !== "boolean") throw new Error("email_on_issue is true or false.");

  // The mail server invoices and reminders are sent through.
  let mail: Config["mail"] = null;
  if (doc.mail !== undefined && doc.mail !== null) {
    const m = doc.mail;
    if (!isObj(m)) throw new Error("mail is a map with host, port, security, user, password and from.");
    keys(m, "mail", ["host", "port", "security", "user", "password", "from"]);
    const security = m.security ?? "starttls";
    if (security !== "starttls" && security !== "tls" && security !== "none") throw new Error("mail.security is starttls, tls or none.");
    const host = text(m.host, "mail.host", 253);
    if (security === "none" && !/^(localhost|127\.0\.0\.1)$/.test(host) && host.includes("."))
      throw new Error("mail.security none is only for a server on this machine or the install's network; use starttls or tls.");
    const port = m.port ?? (security === "tls" ? 465 : 587);
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error("mail.port is a port number.");
    mail = {
      host,
      port: port as number,
      security,
      user: optText(m.user, "mail.user", 254),
      password: m.password === undefined ? "INVOICES_MAIL_PASSWORD" : env(m.password, "mail.password"),
      from: text(m.from, "mail.from", 254),
    };
  }

  // Bank accounts whose statements are imported.
  const bank: BankAccount[] = [];
  const bk = doc.bank ?? {};
  if (!isObj(bk) || Object.keys(bk).length > 20) throw new Error("bank is a map of up to 20 accounts, such as garanti: { iban, format, csv }.");
  for (const [id, v] of Object.entries(bk)) {
    const at = `bank.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: an account id is up to 32 lowercase letters, digits and -.`);
    if (!isObj(v)) throw new Error(`${at} is a map with name, iban, currency, format and csv.`);
    keys(v, at, ["name", "iban", "currency", "format", "csv"]);
    const format = v.format ?? "csv";
    if (format !== "csv" && format !== "mt940") throw new Error(`${at}.format is csv or mt940.`);
    const c = v.csv ?? {};
    if (!isObj(c)) throw new Error(`${at}.csv is a map with date, amount (or credit and debit), description, reference, separator, date_format and decimal.`);
    keys(c, `${at}.csv`, ["date", "amount", "credit", "debit", "description", "reference", "separator", "date_format", "decimal"]);
    const separator = c.separator ?? ";";
    if (separator !== ";" && separator !== "," && separator !== "\t") throw new Error(`${at}.csv.separator is ";", "," or a tab.`);
    const dateFormat = c.date_format ?? "DD.MM.YYYY";
    if (!["DD.MM.YYYY", "YYYY-MM-DD", "DD/MM/YYYY"].includes(dateFormat as string))
      throw new Error(`${at}.csv.date_format is DD.MM.YYYY, DD/MM/YYYY or YYYY-MM-DD.`);
    const decimal = c.decimal ?? ",";
    if (decimal !== "," && decimal !== ".") throw new Error(`${at}.csv.decimal is "," or ".".`);
    const credit = optText(c.credit, `${at}.csv.credit`, 60);
    const amountCol = c.amount === undefined && credit ? null : text(c.amount ?? "Tutar", `${at}.csv.amount`, 60);
    bank.push({
      id,
      name: v.name === undefined ? id : text(v.name, `${at}.name`, 80),
      iban: iban(v.iban, `${at}.iban`),
      currency: v.currency === undefined ? "TRY" : currency(v.currency, `${at}.currency`),
      format,
      csv: {
        date: text(c.date ?? "Tarih", `${at}.csv.date`, 60),
        amount: amountCol,
        credit,
        debit: optText(c.debit, `${at}.csv.debit`, 60),
        description: text(c.description ?? "Açıklama", `${at}.csv.description`, 60),
        reference: optText(c.reference, `${at}.csv.reference`, 60),
        separator,
        dateFormat: dateFormat as BankAccount["csv"]["dateFormat"],
        decimal,
      },
    });
  }

  // CRM: won deals become drafts.
  let crm: Config["crm"] = null;
  if (doc.crm !== undefined && doc.crm !== null) {
    const c = doc.crm;
    if (!isObj(c)) throw new Error("crm is a map with url, token, won_deals and check_every.");
    keys(c, "crm", ["url", "token", "won_deals", "check_every"]);
    const wonDeals = c.won_deals ?? "draft";
    if (wonDeals !== "draft" && wonDeals !== "off") throw new Error("crm.won_deals is draft (each won deal becomes a draft invoice) or off.");
    const ce = /^(\d{1,3})\s*m$/.exec(String(c.check_every ?? "5m"));
    if (!ce || Number(ce[1]) < 1) throw new Error("crm.check_every is a number of minutes, such as 5m.");
    crm = {
      url: baseUrl(c.url, "crm.url"),
      token: c.token === undefined ? "INVOICES_CRM_TOKEN" : env(c.token, "crm.token"),
      wonDeals,
      everyMinutes: Number(ce[1]),
    };
  }

  return {
    timeZone,
    currency: cur,
    language,
    seller,
    series,
    paymentDays,
    tax: { kdvRates, withholding, exemptions },
    integrator,
    exchangeRates,
    reminders,
    emailOnIssue: doc.email_on_issue !== false,
    mail,
    bank,
    crm,
    notes: optText(doc.notes, "notes", 1000),
  };
}

/** Things to fix that do not stop the file from being applied: secrets that are not set, a seller left at the default. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>): string[] {
  const w: string[] = [];
  const unset = (name: string) => !environment[name];
  if (c.seller === DEFAULT_SELLER) w.push("seller: not set, so no invoice can be issued until your name, tax number and address are in the file.");
  if (!c.integrator) w.push("integrator: not set, so invoices can be drafted but not issued.");
  if (c.integrator && c.integrator.provider !== "fake" && unset(c.integrator.apiKey))
    w.push(`integrator: ${c.integrator.apiKey} is not set, so nothing reaches the integrator.`);
  if (c.integrator?.provider === "fake") w.push("integrator: fake, so nothing reaches GİB. Use it only to try Invoices.");
  if (c.mail && unset(c.mail.password) && c.mail.user) w.push(`mail: ${c.mail.password} is not set, so invoices and reminders cannot be emailed.`);
  if (c.crm && unset(c.crm.token)) w.push(`crm: ${c.crm.token} is not set, so won deals are not read.`);
  return w;
}

export const isDefaultSeller = (c: Config) => c.seller === DEFAULT_SELLER;
export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
