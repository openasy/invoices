// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const day = { type: "string", format: "date", examples: ["2026-11-09"] };
const money = { type: "integer", description: "Minor units of the currency: kuruş for TRY. 4500050 is 45.000,50 TL." };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties), extra?: boolean) => ({
  type: "object",
  required,
  properties,
  ...(extra === false && { additionalProperties: false }),
});
const map = { type: "object" };

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const fileOf = (type: string, description: string) => ({ description, content: { [type]: { schema: { type: "string", format: "binary" } } } });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, `Needs the ${role} role.`].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const STATUSES = ["draft", "queued", "waiting", "delivered", "accepted", "rejected", "refused", "failed", "cancelled"];
const Address = obj({ street: nul(str), district: nul(str), city: str, postalCode: nul(str), country: str });
const Owed = obj({ currency: str, amount: money, overdue: money });

const Customer = obj({
  id: str,
  name: str,
  taxId: nul({ type: "string", description: "VKN (10 digits) or TCKN (11); 11111111111 for a person who gives none; null until it is known." }),
  kind: nul({ type: "string", enum: ["company", "person"] }),
  taxOffice: nul(str),
  address: Address,
  email: nul(str),
  phone: nul(str),
  currency: nul(str),
  paymentDays: nul(int),
  crmCompany: nul({ type: "string", description: "The CRM company this customer is." }),
  eInvoice: nul(
    obj({
      registered: { type: "boolean", description: "On GİB's e-Fatura list, as the integrator answered: its invoices go as e-Fatura, others as e-Arşiv." },
      aliases: arr(str),
      checkedAt: dt,
    }),
  ),
  notes: nul(str),
  owed: arr(Owed),
  createdAt: dt,
  updatedAt: dt,
});
const CustomerInput = obj(
  {
    name: str,
    taxId: nul(str),
    taxOffice: nul(str),
    address: obj({ street: nul(str), district: nul(str), city: str, postalCode: nul(str), country: nul(str) }, ["city"], false),
    email: nul(str),
    phone: nul(str),
    currency: nul(str),
    paymentDays: nul(int),
    notes: nul(str),
    crmCompany: nul(str),
  },
  [],
  false,
);
const CatalogItem = obj({
  id: str,
  code: str,
  name: str,
  unit: { type: "string", description: "A UN/ECE Rec. 20 code: C62 piece, HUR hour, DAY, MON month, ANN year, KGM, LTR, MTR, MTK, MTQ, KWH, SET." },
  unitPrice: money,
  currency: str,
  kdvRate: int,
  withholding: nul({ type: "string", description: "A withholding (tevkifat) code, such as 602 or 624." }),
  exemption: nul({ type: "string", description: "A KDV exemption code, needed with 0% KDV, such as 301 or 351." }),
  stock: { type: "boolean", description: "Goods Inventory counts: issuing moves them out of the stock." },
  active: bool,
  createdAt: dt,
  updatedAt: dt,
});
const CatalogInput = obj(
  { code: str, name: str, unit: str, unitPrice: money, currency: str, kdvRate: int, withholding: nul(str), exemption: nul(str), stock: bool, active: bool },
  [],
  false,
);
const Line = obj({
  product: nul(str),
  code: nul(str),
  name: str,
  description: nul(str),
  quantity: { type: "number", description: "Up to three decimals." },
  unit: str,
  unitPrice: money,
  discount: { type: "number", description: "Percent, up to two decimals." },
  kdvRate: int,
  withholding: nul(obj({ code: str, share: { type: "string", examples: ["9/10"] } })),
  exemption: nul(str),
  net: { ...money, description: "Without KDV, after the discount." },
  kdv: money,
  withheld: money,
});
const LineInput = obj(
  {
    product: nul({ type: "string", description: "A catalog item's id or code; its name, unit, price and taxes are the defaults." }),
    code: nul(str),
    name: str,
    description: nul(str),
    quantity: { type: "number", description: "Above 0, up to three decimals; 1 when left out." },
    unit: str,
    unitPrice: money,
    discount: { type: "number", description: "Percent, 0 to 100." },
    kdvRate: int,
    withholding: nul(str),
    exemption: nul(str),
  },
  [],
  false,
);
const Breakdown = obj({ rate: int, exemption: nul(str), base: money, amount: money });
const Invoice = obj({
  id: str,
  kind: { type: "string", enum: ["invoice", "credit_note"] },
  status: {
    type: "string",
    enum: STATUSES,
    description:
      "draft; queued (numbered, to be sent); waiting (the integrator has it); delivered (GİB took it); accepted or rejected (a TICARIFATURA's buyer answered); refused (the integrator refused it before GİB: fix it and issue again); failed (GİB refused it); cancelled (an e-Arşiv invoice).",
  },
  owed: { type: "boolean", description: "An issued invoice that counts as owed: queued, waiting, delivered or accepted." },
  channel: nul({ type: "string", enum: ["e-fatura", "e-arsiv"] }),
  profile: nul({ type: "string", enum: ["TEMELFATURA", "TICARIFATURA", "EARSIVFATURA"] }),
  type: nul({ type: "string", enum: ["SATIS", "TEVKIFAT", "ISTISNA", "IADE"] }),
  number: nul({ type: "string", examples: ["ABC2026000000001"], description: "GİB's 16 characters: series, year, nine digits. null for a draft." }),
  uuid: nul({ type: "string", description: "The ETTN." }),
  customer: obj({ id: str, name: str }),
  issueDate: nul(day),
  issueTime: nul(str),
  dueDate: nul(day),
  currency: str,
  rate: nul(obj({ value: { type: "string", examples: ["34.5678"] }, date: nul(day), source: nul({ type: "string", enum: ["tcmb", "manual"] }) })),
  notes: nul(str),
  orderRef: nul(str),
  period: nul(obj({ start: day, end: day })),
  original: nul(obj({ id: str, number: nul(str) })),
  source: { type: "string", description: "manual, crm, recurring, credit." },
  sourceRef: nul(str),
  lines: arr(Line),
  totals: obj({
    gross: money,
    discount: money,
    net: money,
    kdv: money,
    withheld: money,
    total: { ...money, description: "With KDV." },
    payable: { ...money, description: "With KDV, less the withheld KDV: what the buyer pays." },
    kdvBreakdown: arr(Breakdown),
    withholdingBreakdown: arr(obj({ code: str, share: str, base: money, amount: money })),
  }),
  tryTotals: nul(obj({ net: money, kdv: money, withheld: money, total: money, payable: money })),
  paid: money,
  credited: money,
  balance: { ...money, description: "What is still owed: payable less payments and credit notes." },
  overdue: bool,
  daysOverdue: int,
  paidAt: nul(day),
  integrator: obj({ ref: nul(str), detail: nul(str), attempts: int }),
  alias: nul(str),
  email: bool,
  emailTo: nul(str),
  emailedAt: nul(dt),
  createdAt: dt,
  createdBy: str,
  issuedAt: nul(dt),
  issuedBy: nul(str),
  updatedAt: dt,
  url: str,
  pdf: str,
  xml: nul(str),
});
const Payment = obj({
  id: str,
  invoice: str,
  date: day,
  amount: money,
  method: { type: "string", enum: ["bank", "cash", "card", "other"] },
  reference: nul(str),
  note: nul(str),
  bankLine: nul(str),
  createdAt: dt,
  createdBy: str,
});
const InvoiceDetail = {
  allOf: [
    ref("Invoice"),
    obj({
      payments: arr(ref("Payment")),
      creditNotes: arr(obj({ id: str, number: nul(str), status: str, payable: money, issueDate: nul(day) })),
      reminders: arr(obj({ kind: { type: "string", enum: ["before", "after"] }, days: int, sentAt: dt, error: nul(str) })),
      events: arr(obj({ at: dt, by: str, what: str, detail: nul(str) })),
    }),
  ],
};
const InvoiceInput = obj(
  {
    customer: { description: "A customer id, or { id }, { taxId }, { email } or { crmCompany }." },
    currency: str,
    issueDate: nul(day),
    dueDate: nul(day),
    lines: arr(ref("LineInput")),
    notes: nul(str),
    orderRef: nul(str),
    period: nul(obj({ start: day, end: day })),
    rate: nul({ type: "string", description: "TRY per unit with up to four decimals; null takes TCMB's rate of the day before the invoice." }),
    email: bool,
    emailTo: nul(str),
    billableItems: { ...arr(str), description: "Billable items (ids or external ids) added as lines." },
  },
  [],
  false,
);
const BillableItem = obj({
  id: str,
  externalId: str,
  source: str,
  customer: str,
  date: day,
  description: str,
  quantity: num,
  unit: str,
  unitPrice: money,
  currency: str,
  kdvRate: int,
  invoice: nul(str),
});
const Recurring = obj({
  id: str,
  name: str,
  customer: str,
  currency: str,
  lines: arr(ref("LineInput")),
  notes: nul(str),
  everyMonths: int,
  dayOfMonth: int,
  start: day,
  end: nul(day),
  next: nul(day),
  mode: { type: "string", enum: ["issue", "draft"] },
  active: bool,
  made: int,
  lastInvoice: nul(str),
  lastError: nul(str),
  createdAt: dt,
  createdBy: str,
});
const BankLine = obj({
  id: str,
  account: str,
  date: day,
  amount: { type: "integer", description: "Minor units; money in above 0, money out below." },
  currency: str,
  description: str,
  reference: nul(str),
  state: { type: "string", enum: ["matched", "unmatched", "ignored", "outgoing"] },
  invoice: nul(obj({ id: str, number: nul(str) })),
});

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        description: "Stable; match on this.",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "forbidden",
          "not-found",
          "conflict",
          "not-linked",
          "link-failed",
          "rate-limited",
          "payload-too-large",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "cross-site",
        ],
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "invoices" }, version: str }),
  ProductList: obj({ products: arr(obj({ id: str, url: str })) }),
  Summary: obj({
    owed: arr(obj({ currency: str, owed: money, overdue: money, invoices: int, overdueInvoices: int })),
    customers: arr(obj({ customer: obj({ id: str, name: str }), currency: str, owed: money, overdue: money })),
    drafts: int,
    sending: int,
    refused: int,
    unmatchedBankLines: int,
    openBillableItems: int,
  }),
  Settings: obj(
    {
      timeZone: str,
      currency: str,
      language: str,
      seller: map,
      sellerSet: bool,
      series: obj({ eFatura: str, eArsiv: str }),
      paymentDays: int,
      kdvRates: arr(int),
      withholding: arr(obj({ code: str, name: str, share: str })),
      exemptions: arr(obj({ code: str, name: str, exempt: bool })),
      units: arr(obj({ code: str, name: str })),
      integrator: nul(obj({ provider: str, url: str, profile: str, keySet: bool })),
      exchangeRates: obj({ url: str, rate: str }),
      reminders: obj({ before: arr(int), after: arr(int), at: str }),
      emailOnIssue: bool,
      mail: nul(obj({ host: str, port: int, from: str })),
      bank: arr(obj({ id: str, name: str, iban: nul(str), currency: str, format: str })),
      crm: nul(obj({ url: str, wonDeals: str })),
      file: nul(obj({ path: str, appliedAt: nul(dt), error: nul(str), warnings: arr(str) })),
      text: { type: "string", description: "The file as it was applied." },
    },
    undefined,
  ),
  Rate: obj({
    currency: str,
    date: day,
    bulletin: { ...day, description: "The TCMB bulletin the rate is from: the last one before date." },
    kind: str,
    rate: str,
  }),
  Customer,
  CustomerDetail: { allOf: [ref("Customer"), obj({ invoices: arr(ref("Invoice")), billableItems: arr(ref("BillableItem")) })] },
  CustomerInput,
  CustomerList: obj({ customers: arr(ref("Customer")) }),
  CatalogItem,
  CatalogInput,
  CatalogList: obj({ items: arr(ref("CatalogItem")) }),
  LineInput,
  Invoice,
  InvoiceDetail,
  InvoiceInput,
  InvoiceList: obj({ invoices: arr(ref("Invoice")) }),
  IssueRequest: obj({ date: { ...day, description: "Today when left out; at most seven days ago (VUK 231/5), never before the series' last." } }, [], false),
  CreditNoteRequest: obj(
    {
      lines: {
        ...arr(obj({ line: int, quantity: num }, ["line"], false)),
        description: "Which lines are returned and how many; every line in full when left out.",
      },
      reason: nul(str),
    },
    [],
    false,
  ),
  EmailRequest: obj({ to: nul(str), kind: { type: "string", enum: ["issued", "reminder"] } }, [], false),
  Payment,
  PaymentInput: obj(
    { date: day, amount: money, method: { type: "string", enum: ["bank", "cash", "card", "other"] }, reference: nul(str), note: nul(str) },
    ["amount"],
    false,
  ),
  StatementImport: obj(
    {
      account: { type: "string", description: "An account id under bank in the file." },
      filename: nul(str),
      content: { type: "string", description: "The file's text: CSV or MT940." },
    },
    ["account", "content"],
    false,
  ),
  StatementResult: obj({ statement: str, lines: int, added: int, duplicates: int, matched: int, unmatched: int, outgoing: int }),
  BankLine,
  BankLineList: obj({ lines: arr(ref("BankLine")) }),
  BankLineResolve: obj({ invoice: str, ignore: bool }, [], false),
  Recurring,
  RecurringInput: obj(
    {
      name: str,
      customer: { description: "A customer id, or { id }, { taxId }, { email } or { crmCompany }." },
      currency: str,
      lines: arr(ref("LineInput")),
      notes: nul(str),
      everyMonths: int,
      start: day,
      end: nul(day),
      mode: { type: "string", enum: ["issue", "draft"] },
      active: bool,
    },
    [],
    false,
  ),
  RecurringList: obj({ recurring: arr(ref("Recurring")) }),
  InvoicesLookup: obj(
    {
      customer: obj({ id: str, name: str, email: nul(str), taxId: nul(str), url: str }),
      owed: arr(Owed),
      invoices: arr(
        obj({
          id: str,
          number: str,
          kind: { type: "string", enum: ["invoice", "credit_note"] },
          date: day,
          due: nul(day),
          currency: str,
          payable: money,
          balance: money,
          status: str,
          overdue: bool,
          url: str,
        }),
      ),
    },
    undefined,
  ),
  BillableBatch: obj(
    {
      items: arr(
        obj(
          {
            external_id: { type: "string", description: "The sender's id; the same one is taken once." },
            source: { type: "string", description: "time when left out." },
            customer: { description: "{ taxId }, { email }, { crmCompany } or { id }, or a customer id." },
            date: day,
            description: str,
            quantity: { type: "number", description: "Hours, or units of unit." },
            unit: { type: "string", description: "HUR when left out." },
            unitPrice: money,
            currency: str,
            kdvRate: int,
          },
          ["external_id", "customer", "date", "description", "quantity", "unitPrice"],
          false,
        ),
      ),
    },
    ["items"],
    false,
  ),
  BillableResult: obj({ added: int, existing: int, items: arr(str) }),
  BillableItem,
  BillableList: obj({ items: arr(ref("BillableItem")) }),
  StockMovements: obj({
    movements: arr(
      obj({
        seq: int,
        invoice: str,
        number: str,
        product: nul(str),
        code: str,
        quantity: { type: "number", description: "Below 0 left the stock (an invoice); above 0 came back (a credit note, a cancelled or rejected invoice)." },
        unit: str,
        date: day,
        at: dt,
      }),
    ),
    next: { type: "integer", description: "Ask again with after=next." },
  }),
  ErasureRequest: obj({
    reference: str,
    product: { const: "audience" },
    people: obj({ emails: arr(str), phones: arr(str), userIds: arr(str) }),
  }),
  ErasureAnswer: obj({ status: { type: "string", enum: ["done", "waiting"] }, deleted: int, detail: str }, ["status"]),
};

const range = [query("from", "First day, YYYY-MM-DD; the first of this month when left out."), query("to", "Last day; today when left out.")];

const paths: Record<string, S> = {
  "/api/v1/version": {
    get: pub({ operationId: "version", tags: ["Product"], summary: "The product and its version", responses: { "200": ok(ref("Version")) } }),
  },
  "/api/v1/products": {
    get: op("viewer", { operationId: "products", tags: ["Product"], summary: "The install's other products", responses: { "200": ok(ref("ProductList")) } }),
  },
  "/api/v1/summary": {
    get: op("viewer", {
      operationId: "summary",
      tags: ["Product"],
      summary: "What is owed and overdue, by currency and customer",
      responses: { "200": ok(ref("Summary")) },
    }),
  },
  "/api/v1/settings": {
    get: op("viewer", {
      operationId: "settings",
      tags: ["Product"],
      summary: "The settings, as invoices.yaml sets them",
      description: "Read-only: the file is the only way to change them.",
      responses: { "200": ok(ref("Settings")) },
    }),
  },
  "/api/v1/rates": {
    get: op("viewer", {
      operationId: "rate",
      tags: ["Product"],
      summary: "TCMB's rate an invoice of a day takes",
      parameters: [query("currency", "USD, EUR, GBP…"), query("date", "The invoice's day; today when left out.")],
      responses: { "200": ok(ref("Rate")), "422": problem, "502": problem },
    }),
  },

  "/api/v1/customers": {
    get: op("viewer", {
      operationId: "listCustomers",
      tags: ["Customers"],
      summary: "Customers",
      parameters: [query("q", "Part of the name, a tax number or an email.")],
      responses: { "200": ok(ref("CustomerList")) },
    }),
    post: op("editor", {
      operationId: "createCustomer",
      tags: ["Customers"],
      summary: "Add a customer",
      requestBody: json(ref("CustomerInput")),
      responses: { "201": ok(ref("Customer"), "Added."), "400": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/customers/{id}": {
    get: op("viewer", {
      operationId: "getCustomer",
      tags: ["Customers"],
      summary: "A customer with their invoices",
      parameters: id("customer"),
      responses: { "200": ok(ref("CustomerDetail")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateCustomer",
      tags: ["Customers"],
      summary: "Change a customer",
      description: "Invoices already issued keep the buyer as it was.",
      parameters: id("customer"),
      requestBody: json(ref("CustomerInput")),
      responses: { "200": ok(ref("Customer")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "removeCustomer",
      tags: ["Customers"],
      summary: "Delete a customer with no issued invoices",
      parameters: id("customer"),
      responses: { "204": { description: "Deleted, with their drafts." }, "404": problem, "409": problem },
    }),
  },
  "/api/v1/customers/{id}/check": {
    post: op("editor", {
      operationId: "checkCustomer",
      tags: ["Customers"],
      summary: "Ask the integrator whether the customer is an e-Fatura user",
      parameters: id("customer"),
      responses: { "200": ok(ref("Customer")), "404": problem, "409": problem, "422": problem, "502": problem },
    }),
  },

  "/api/v1/catalog": {
    get: op("viewer", {
      operationId: "listCatalog",
      tags: ["Catalog"],
      summary: "Products and services",
      parameters: [query("q", "Part of the name or code."), query("all", "true to list inactive ones too.")],
      responses: { "200": ok(ref("CatalogList")) },
    }),
    post: op("editor", {
      operationId: "createCatalogItem",
      tags: ["Catalog"],
      summary: "Add a product or service",
      requestBody: json(ref("CatalogInput")),
      responses: { "201": ok(ref("CatalogItem"), "Added."), "400": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/catalog/{id}": {
    patch: op("editor", {
      operationId: "updateCatalogItem",
      tags: ["Catalog"],
      summary: "Change a product or service",
      parameters: id("item"),
      requestBody: json(ref("CatalogInput")),
      responses: { "200": ok(ref("CatalogItem")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "removeCatalogItem",
      tags: ["Catalog"],
      summary: "Delete it, or take it off the list when an invoice has it",
      parameters: id("item"),
      responses: { "204": { description: "Gone." }, "404": problem },
    }),
  },

  "/api/v1/invoices": {
    get: op("viewer", {
      operationId: "listInvoices",
      tags: ["Invoices"],
      summary: "Invoices and credit notes",
      parameters: [
        query("status", "owed, overdue, or a status."),
        query("kind", "invoice or credit_note."),
        query("customer", "A customer's id."),
        query("q", "Part of the number or the customer's name."),
        ...range.map((r) => ({ ...r, description: r.name === "from" ? "Issued on or after." : "Issued on or before." })),
      ],
      responses: { "200": ok(ref("InvoiceList")), "422": problem },
    }),
    post: op("editor", {
      operationId: "createInvoice",
      tags: ["Invoices"],
      summary: "Draft an invoice",
      description: "A draft has no number; issuing gives it one.",
      requestBody: json(ref("InvoiceInput")),
      responses: { "201": ok(ref("InvoiceDetail"), "Drafted."), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/invoices/{id}": {
    get: op("viewer", {
      operationId: "getInvoice",
      tags: ["Invoices"],
      summary: "An invoice with its payments and history",
      parameters: [{ name: "id", in: "path", required: true, description: "The invoice's id or number.", schema: str }],
      responses: { "200": ok(ref("InvoiceDetail")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateInvoice",
      tags: ["Invoices"],
      summary: "Change a draft, or an invoice the integrator refused",
      description: "A sent invoice is never changed (409); a credit note corrects it. A refused one keeps its number, date and currency.",
      parameters: id("invoice"),
      requestBody: json(ref("InvoiceInput")),
      responses: { "200": ok(ref("InvoiceDetail")), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "removeInvoice",
      tags: ["Invoices"],
      summary: "Delete a draft",
      description: "An invoice with a number is kept, so no number is skipped.",
      parameters: id("invoice"),
      responses: { "204": { description: "Deleted." }, "404": problem, "409": problem },
    }),
  },
  "/api/v1/invoices/{id}/issue": {
    post: op("editor", {
      operationId: "issueInvoice",
      tags: ["Invoices"],
      summary: "Issue: e-Fatura or e-Arşiv, the next number, the UBL-TR XML, and on to the integrator",
      description:
        "Asks the integrator whether the buyer is an e-Fatura user, takes TCMB's rate for a foreign currency, gives the next number of the series and year, writes and checks the UBL-TR XML, and queues it to be sent. An invoice the integrator refused is issued again under its number with a new ETTN.",
      parameters: id("invoice"),
      requestBody: { required: false, content: { "application/json": { schema: ref("IssueRequest") } } },
      responses: { "200": ok(ref("InvoiceDetail")), "400": problem, "404": problem, "409": problem, "422": problem, "502": problem },
    }),
  },
  "/api/v1/invoices/{id}/credit-notes": {
    post: op("editor", {
      operationId: "creditNote",
      tags: ["Invoices"],
      summary: "Draft a credit note (an IADE invoice) of an issued invoice",
      parameters: id("invoice"),
      requestBody: { required: false, content: { "application/json": { schema: ref("CreditNoteRequest") } } },
      responses: { "201": ok(ref("InvoiceDetail"), "Drafted; issue it like an invoice."), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/invoices/{id}/cancel": {
    post: op("editor", {
      operationId: "cancelInvoice",
      tags: ["Invoices"],
      summary: "Cancel an e-Arşiv invoice through the integrator",
      parameters: id("invoice"),
      responses: { "200": ok(ref("InvoiceDetail")), "404": problem, "409": problem, "502": problem },
    }),
  },
  "/api/v1/invoices/{id}/email": {
    post: op("editor", {
      operationId: "emailInvoice",
      tags: ["Invoices"],
      summary: "Email the invoice, or a reminder, now",
      parameters: id("invoice"),
      requestBody: { required: false, content: { "application/json": { schema: ref("EmailRequest") } } },
      responses: { "200": ok(ref("InvoiceDetail")), "404": problem, "409": problem, "422": problem, "502": problem },
    }),
  },
  "/api/v1/invoices/{id}/payments": {
    post: op("editor", {
      operationId: "addPayment",
      tags: ["Payments"],
      summary: "Record a payment, in full or in part",
      parameters: id("invoice"),
      requestBody: json(ref("PaymentInput")),
      responses: { "201": ok(ref("Payment"), "Recorded."), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/invoices/{id}/pdf": {
    get: op("viewer", {
      operationId: "invoicePdf",
      tags: ["Invoices"],
      summary: "The invoice as PDF",
      parameters: id("invoice"),
      responses: { "200": fileOf("application/pdf", "The PDF; a draft is marked TASLAK."), "404": problem },
    }),
  },
  "/api/v1/invoices/{id}/xml": {
    get: op("viewer", {
      operationId: "invoiceXml",
      tags: ["Invoices"],
      summary: "The UBL-TR XML sent to the integrator",
      parameters: id("invoice"),
      responses: { "200": fileOf("application/xml", "UBL-TR 1.2, unsigned: the integrator signs it."), "404": problem },
    }),
  },
  "/api/v1/payments/{id}": {
    delete: op("editor", {
      operationId: "removePayment",
      tags: ["Payments"],
      summary: "Remove a payment",
      parameters: id("payment"),
      responses: { "204": { description: "Removed." }, "404": problem },
    }),
  },

  "/api/v1/bank/statements": {
    post: op("editor", {
      operationId: "importStatement",
      tags: ["Payments"],
      summary: "Import a bank statement and match it to invoices",
      description:
        "A line of money in pays the owed invoice whose number is in its text, or the one owed invoice of exactly that amount whose customer's name or tax number is in it. Lines seen before are not added again.",
      requestBody: json(ref("StatementImport")),
      responses: { "201": ok(ref("StatementResult"), "Imported."), "400": problem, "413": problem, "422": problem },
    }),
  },
  "/api/v1/bank/lines": {
    get: op("viewer", {
      operationId: "listBankLines",
      tags: ["Payments"],
      summary: "Bank lines",
      parameters: [query("state", "unmatched (default), matched, ignored, outgoing or all.")],
      responses: { "200": ok(ref("BankLineList")), "422": problem },
    }),
  },
  "/api/v1/bank/lines/{id}": {
    post: op("editor", {
      operationId: "resolveBankLine",
      tags: ["Payments"],
      summary: "Match a line to an invoice by hand, or ignore it",
      parameters: id("line"),
      requestBody: json(ref("BankLineResolve")),
      responses: { "200": ok(ref("BankLine")), "404": problem, "409": problem, "422": problem },
    }),
  },

  "/api/v1/recurring": {
    get: op("viewer", { operationId: "listRecurring", tags: ["Recurring"], summary: "Recurring invoices", responses: { "200": ok(ref("RecurringList")) } }),
    post: op("editor", {
      operationId: "createRecurring",
      tags: ["Recurring"],
      summary: "Invoice a customer every few months",
      requestBody: json(ref("RecurringInput")),
      responses: { "201": ok(ref("Recurring"), "Added."), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/recurring/{id}": {
    get: op("viewer", {
      operationId: "getRecurring",
      tags: ["Recurring"],
      summary: "A recurring invoice",
      parameters: id("recurring invoice"),
      responses: { "200": ok(ref("Recurring")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateRecurring",
      tags: ["Recurring"],
      summary: "Change a recurring invoice",
      parameters: id("recurring invoice"),
      requestBody: json(ref("RecurringInput")),
      responses: { "200": ok(ref("Recurring")), "404": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "removeRecurring",
      tags: ["Recurring"],
      summary: "Stop and delete a recurring invoice",
      parameters: id("recurring invoice"),
      responses: { "204": { description: "Deleted; invoices it made stay." }, "404": problem },
    }),
  },

  "/api/v1/exports/invoices.csv": {
    get: op("viewer", {
      operationId: "exportInvoices",
      tags: ["Exports"],
      summary: "Issued invoices and credit notes for the accountant",
      description: "Semicolons and decimal commas, as Excel opens them in Turkish: KDV by rate, withholding, TRY values.",
      parameters: range,
      responses: { "200": fileOf("text/csv", "CSV."), "422": problem },
    }),
  },
  "/api/v1/exports/payments.csv": {
    get: op("viewer", {
      operationId: "exportPayments",
      tags: ["Exports"],
      summary: "Payments received",
      parameters: range,
      responses: { "200": fileOf("text/csv", "CSV."), "422": problem },
    }),
  },
  "/api/v1/exports/ubl.zip": {
    get: op("viewer", {
      operationId: "exportUbl",
      tags: ["Exports"],
      summary: "The UBL-TR XML files",
      parameters: range,
      responses: { "200": fileOf("application/zip", "A ZIP of NUMBER.xml files."), "422": problem },
    }),
  },

  "/api/v1/lookup": {
    get: op("viewer", {
      operationId: "lookup",
      tags: ["Contracts"],
      summary: "A customer's invoices and what they owe, for Helpdesk",
      description: "By email (exactly, lowercased) or by an invoice number. 404 when nothing matches.",
      parameters: [query("email", "The customer's email."), query("number", "An invoice number.")],
      responses: { "200": ok(ref("InvoicesLookup")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/billable-items": {
    get: op("viewer", {
      operationId: "listBillable",
      tags: ["Contracts"],
      summary: "Billable items waiting for an invoice",
      parameters: [query("customer", "A customer's id."), query("open", "false to list invoiced ones too.")],
      responses: { "200": ok(ref("BillableList")) },
    }),
    post: op("editor", {
      operationId: "addBillable",
      tags: ["Contracts"],
      summary: "Send billable hours, from Time",
      description: "Each waits for an invoice that takes it (billableItems on a draft). The same external_id is taken once.",
      requestBody: json(ref("BillableBatch")),
      responses: { "200": ok(ref("BillableResult")), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/stock-movements": {
    get: op("viewer", {
      operationId: "stockMovements",
      tags: ["Contracts"],
      summary: "Goods that left the stock or came back, for Inventory",
      parameters: [query("after", "The last seq read; 0 for the first.", int), query("limit", "Up to 1000.", int)],
      responses: { "200": ok(ref("StockMovements")), "422": problem },
    }),
  },
  "/api/v1/crm/deals/{id}": {
    post: op("editor", {
      operationId: "draftFromDeal",
      tags: ["Contracts"],
      summary: "Draft an invoice from a won CRM deal",
      description: "Its accepted quote's lines, else its name and value. Once per deal: the same deal answers 200 with its invoice.",
      parameters: id("CRM deal"),
      responses: {
        "201": ok(ref("InvoiceDetail"), "Drafted."),
        "200": ok(ref("InvoiceDetail"), "Drafted before."),
        "404": problem,
        "409": problem,
        "502": problem,
      },
    }),
  },
  "/api/v1/erasures": {
    post: op("admin", {
      operationId: "erase",
      tags: ["Contracts"],
      summary: "Delete a person on request, as Audience asks",
      description:
        "Waiting while one of their invoices is unpaid. Customers with no issued invoice are deleted; one with issued invoices loses their email and phone, and the invoices are kept for ten years (VUK 253, TTK 82).",
      requestBody: json(ref("ErasureRequest")),
      responses: { "200": ok(ref("ErasureAnswer"), "Done."), "202": ok(ref("ErasureAnswer"), "Waiting."), "400": problem, "422": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy Invoices",
    version,
    description:
      "Invoices and credit notes with KDV and withholding, issued as e-Fatura or e-Arşiv through the GİB integrator invoices.yaml sets, with payments, reminders, recurring invoices, bank statements and exports for the accountant. Amounts are whole numbers of minor units (kuruş for TRY). Viewers read everything; editors change everything but erasures; admins also erase.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
