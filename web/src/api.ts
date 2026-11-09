// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json. Every amount is a whole
// number of minor units (kuruş for TRY), as the API gives it; the pages never add up money themselves.

export interface ProductLink {
  id: string;
  url: string;
}

export type Status = "draft" | "queued" | "waiting" | "delivered" | "accepted" | "rejected" | "refused" | "failed" | "cancelled";
export type Channel = "e-fatura" | "e-arsiv";
export type Profile = "TEMELFATURA" | "TICARIFATURA" | "EARSIVFATURA";
export type TypeCode = "SATIS" | "TEVKIFAT" | "ISTISNA" | "IADE";

export interface Settings {
  timeZone: string;
  currency: string;
  language: string;
  seller: {
    name: string;
    taxId: string;
    taxOffice: string | null;
    address?: { street?: string | null; district?: string | null; city?: string; postalCode?: string | null; country?: string };
    email?: string | null;
    iban?: string | null;
    bank?: string | null;
  };
  sellerSet: boolean;
  series: { eFatura: string; eArsiv: string };
  paymentDays: number;
  kdvRates: number[];
  withholding: Array<{ code: string; name: string; share: string }>;
  exemptions: Array<{ code: string; name: string; exempt: boolean }>;
  units: Array<{ code: string; name: string }>;
  integrator: { provider: string; url: string; profile: string; keySet: boolean } | null;
  exchangeRates: { url: string; rate: "forex_buying" | "forex_selling" | "banknote_buying" | "banknote_selling" };
  reminders: { before: number[]; after: number[]; at: string };
  emailOnIssue: boolean;
  mail: { host: string; port: number; from: string } | null;
  bank: Array<{ id: string; name: string; iban: string | null; currency: string; format: string }>;
  crm: { url: string; wonDeals: string } | null;
  file: { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;
  text: string;
}

export interface Summary {
  drafts: number;
  sending: number;
  refused: number;
  unmatchedBankLines: number;
  openBillableItems: number;
}

export interface Overview {
  currency: string;
  today: string;
  owed: { amount: number; invoices: number };
  overdue: { amount: number; invoices: number; oldestDays: number };
  collected: { month: string; amount: number; payments: number; fromBank: number };
  daysToPay: { last90: number | null; previous90: number | null };
  waiting: { drafts: number; refused: number };
  unmatchedBankLines: number;
  months: Array<{ month: string; paid: number; owed: number }>;
  ages: Array<{ age: "current" | "1-30" | "31-60" | "60+"; amount: number }>;
  customers: Array<{
    customer: { id: string; name: string };
    invoices: number;
    owed: number;
    overdue: number;
    oldest: { id: string; number: string; daysOverdue: number } | null;
  }>;
}

export interface Owed {
  currency: string;
  amount: number;
  overdue: number;
}

export interface Address {
  street: string | null;
  district: string | null;
  city: string;
  postalCode: string | null;
  country: string;
}

export interface Customer {
  id: string;
  name: string;
  taxId: string | null;
  kind: "company" | "person" | null;
  taxOffice: string | null;
  address: Address;
  email: string | null;
  phone: string | null;
  currency: string | null;
  paymentDays: number | null;
  crmCompany: string | null;
  eInvoice: { registered: boolean; aliases: string[]; checkedAt: string } | null;
  notes: string | null;
  owed: Owed[];
}

export interface CatalogItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  unitPrice: number;
  currency: string;
  kdvRate: number;
  withholding: string | null;
  exemption: string | null;
  stock: boolean;
  active: boolean;
}

export interface Line {
  product: string | null;
  code: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  discount: number;
  kdvRate: number;
  withholding: { code: string; share: string } | null;
  exemption: string | null;
  net: number;
  kdv: number;
  withheld: number;
}

/** A line as the API takes it. */
export interface LineInput {
  product?: string | null;
  code?: string | null;
  name?: string;
  description?: string | null;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  discount?: number;
  kdvRate?: number;
  withholding?: string | null;
  exemption?: string | null;
}

export interface Totals {
  gross: number;
  discount: number;
  net: number;
  kdv: number;
  withheld: number;
  total: number;
  payable: number;
  kdvBreakdown: Array<{ rate: number; exemption: string | null; base: number; amount: number }>;
  withholdingBreakdown: Array<{ code: string; share: string; base: number; amount: number }>;
}

export interface Invoice {
  id: string;
  kind: "invoice" | "credit_note";
  status: Status;
  owed: boolean;
  channel: Channel | null;
  profile: Profile | null;
  type: TypeCode | null;
  number: string | null;
  uuid: string | null;
  customer: { id: string; name: string };
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  rate: { value: string; date: string | null; source: "tcmb" | "manual" | null } | null;
  notes: string | null;
  orderRef: string | null;
  period: { start: string; end: string } | null;
  original: { id: string; number: string | null } | null;
  source: string;
  sourceRef: string | null;
  lines: Line[];
  totals: Totals;
  tryTotals: { net: number; kdv: number; withheld: number; total: number; payable: number } | null;
  paid: number;
  credited: number;
  balance: number;
  overdue: boolean;
  daysOverdue: number;
  paidAt: string | null;
  integrator: { ref: string | null; detail: string | null; attempts: number };
  alias: string | null;
  email: boolean;
  emailTo: string | null;
  emailedAt: string | null;
  createdAt: string;
  createdBy: string;
  issuedAt: string | null;
  issuedBy: string | null;
  pdf: string;
  xml: string | null;
}

export interface Payment {
  id: string;
  invoice: string;
  date: string;
  amount: number;
  method: "bank" | "cash" | "card" | "other";
  reference: string | null;
  note: string | null;
  bankLine: string | null;
  createdBy: string;
}

export interface ReminderStep {
  kind: "before" | "after";
  days: number;
  on: string;
  state: "sent" | "failed" | "planned" | "passed" | "stopped";
}

export interface InvoiceDetail extends Invoice {
  payments: Payment[];
  creditNotes: Array<{ id: string; number: string | null; status: string; payable: number; issueDate: string | null }>;
  reminders: Array<{ kind: "before" | "after"; days: number; sentAt: string; error: string | null }>;
  events: Array<{ at: string; by: string; what: string; detail: string | null }>;
  reminderPlan: ReminderStep[];
}

export interface Preview {
  currency: string;
  lines: Array<{ net: number; kdv: number; withheld: number }>;
  totals: Totals;
  type: TypeCode | null;
  typeError: string | null;
  channel: Channel;
  channelKnown: boolean;
  alias: string | null;
  profile: Profile;
  next: string;
}

export interface Recurring {
  id: string;
  name: string;
  customer: string;
  currency: string;
  lines: LineInput[];
  notes: string | null;
  everyMonths: number;
  dayOfMonth: number;
  start: string;
  end: string | null;
  next: string | null;
  mode: "issue" | "draft";
  active: boolean;
  made: number;
  lastInvoice: string | null;
  lastError: string | null;
  totals: { net: number; kdv: number; withheld: number; payable: number } | null;
}

export interface BankLine {
  id: string;
  account: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  reference: string | null;
  state: "matched" | "unmatched" | "ignored" | "outgoing";
  invoice: { id: string; number: string | null } | null;
}

export interface Statement {
  id: string;
  account: string;
  filename: string | null;
  importedAt: string;
  importedBy: string;
  lines: number;
}

export interface StatementResult {
  lines: number;
  added: number;
  duplicates: number;
  matched: number;
  unmatched: number;
  outgoing: number;
}

export interface ImportResult {
  added: number;
  updated: number;
  errors: Array<{ row: number; message: string }>;
}

export interface ExportCounts {
  from: string;
  to: string;
  invoices: number;
  creditNotes: number;
  payments: number;
  xml: number;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
