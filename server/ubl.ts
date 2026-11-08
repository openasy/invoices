// UBL-TR 1.2: the invoice as GİB reads it, written here and checked here before it goes to the integrator. The
// integrator signs it with its financial seal (mali mühür) and passes it to GİB; Invoices never signs. The elements
// are in the order UBL 2.1's schema sets, and the checks in validateUbl are the GİB schematron rules an invoice of
// this product can break, with the sums checked to the kuruş. They are not GİB's own schematron: the integrator runs
// that one too and refuses what fails it.
import type { Address } from "./config.ts";
import { mulDiv, type InvoiceTypeCode, type LineTotals, type TaxTables, type Totals } from "./tax.ts";
import { el, first, kids, local, parseXml, textAt, type XmlNode } from "./xml.ts";

export type Profile = "TEMELFATURA" | "TICARIFATURA" | "EARSIVFATURA";

/** Units as UN/ECE Recommendation 20 codes, which UBL-TR's unitCode takes, with their Turkish names. */
export const UNITS: Record<string, { tr: string; en: string }> = {
  C62: { tr: "Adet", en: "Piece" },
  HUR: { tr: "Saat", en: "Hour" },
  DAY: { tr: "Gün", en: "Day" },
  MON: { tr: "Ay", en: "Month" },
  ANN: { tr: "Yıl", en: "Year" },
  KGM: { tr: "Kg", en: "kg" },
  GRM: { tr: "Gram", en: "Gram" },
  LTR: { tr: "Litre", en: "Litre" },
  MTR: { tr: "Metre", en: "Metre" },
  MTK: { tr: "m²", en: "m²" },
  MTQ: { tr: "m³", en: "m³" },
  KWH: { tr: "kWh", en: "kWh" },
  SET: { tr: "Set", en: "Set" },
};

export interface Party {
  name: string;
  taxId: string;
  taxOffice: string | null;
  address: Address;
  email: string | null;
  phone: string | null;
  website?: string | null;
  mersis?: string | null;
  tradeRegistry?: string | null;
}

export interface DocLine {
  name: string;
  code: string | null;
  description: string | null;
  /** Thousandths. */
  quantity: number;
  unit: string;
  unitPrice: number;
  /** Hundredths of a percent. */
  discount: number;
  kdvRate: number;
  withholding: string | null;
  exemption: string | null;
  totals: LineTotals;
}

export interface InvoiceDocument {
  uuid: string;
  number: string;
  profile: Profile;
  type: InvoiceTypeCode;
  issueDate: string;
  /** HH:MM:SS in the install's time zone. */
  issueTime: string;
  dueDate: string | null;
  currency: string;
  /** TRY per unit of the currency, in ten-thousandths; null for TRY. */
  rate: number | null;
  seller: Party;
  buyer: Party;
  lines: DocLine[];
  totals: Totals;
  notes: string[];
  /** The invoice a credit note (IADE) corrects. */
  reference: { number: string; date: string } | null;
  period: { start: string; end: string } | null;
  orderReference: string | null;
  /** Where to pay, written as PaymentMeans. */
  iban: string | null;
}

const NS = {
  xmlns: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  "xmlns:cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  "xmlns:cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  "xmlns:ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};

/** 4500050 minor units is 45000.50: UBL amounts have a dot and two decimals. */
export const amt = (minor: number) => `${minor < 0 ? "-" : ""}${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, "0")}`;
export const qty = (milli: number) => {
  const s = `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, "0")}`.replace(/\.?0+$/, "");
  return s || "0";
};
export const rate4 = (r: number) => `${Math.floor(r / 10000)}.${String(r % 10000).padStart(4, "0")}`;

/** A person's name as GİB splits it for a TCKN: the last word is the family name. */
export function splitName(name: string): { first: string; family: string } {
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? { first: parts[0] ?? name, family: parts[0] ?? name } : { first: parts.slice(0, -1).join(" "), family: parts.at(-1)! };
}

function party(p: Party, supplier: boolean): string {
  const tckn = p.taxId.length === 11;
  const ids = [
    el("cac:PartyIdentification", null, [el("cbc:ID", { schemeID: tckn ? "TCKN" : "VKN" }, p.taxId)]),
    p.mersis ? el("cac:PartyIdentification", null, [el("cbc:ID", { schemeID: "MERSISNO" }, p.mersis)]) : null,
    p.tradeRegistry ? el("cac:PartyIdentification", null, [el("cbc:ID", { schemeID: "TICARETSICILNO" }, p.tradeRegistry)]) : null,
  ];
  const a = p.address;
  return el("cac:Party", null, [
    p.website ? el("cbc:WebsiteURI", null, p.website) : null,
    ...ids,
    tckn ? null : el("cac:PartyName", null, [el("cbc:Name", null, p.name)]),
    el("cac:PostalAddress", null, [
      a.street ? el("cbc:StreetName", null, a.street) : null,
      el("cbc:CitySubdivisionName", null, a.district ?? a.city),
      el("cbc:CityName", null, a.city),
      a.postalCode ? el("cbc:PostalZone", null, a.postalCode) : null,
      el("cac:Country", null, [el("cbc:Name", null, a.country)]),
    ]),
    p.taxOffice || supplier ? el("cac:PartyTaxScheme", null, [el("cac:TaxScheme", null, [el("cbc:Name", null, p.taxOffice ?? "")])]) : null,
    p.phone || p.email
      ? el("cac:Contact", null, [p.phone ? el("cbc:Telephone", null, p.phone) : null, p.email ? el("cbc:ElectronicMail", null, p.email) : null])
      : null,
    tckn ? el("cac:Person", null, [el("cbc:FirstName", null, splitName(p.name).first), el("cbc:FamilyName", null, splitName(p.name).family)]) : null,
  ]);
}

function kdvSubtotal(cur: string, base: number, amount: number, rate: number, exemption: string | null, t: TaxTables): string {
  const ex = exemption ? t.exemptions.get(exemption) : undefined;
  return el("cac:TaxSubtotal", null, [
    el("cbc:TaxableAmount", { currencyID: cur }, amt(base)),
    el("cbc:TaxAmount", { currencyID: cur }, amt(amount)),
    el("cbc:Percent", null, String(rate)),
    el("cac:TaxCategory", null, [
      exemption ? el("cbc:TaxExemptionReasonCode", null, exemption) : null,
      exemption ? el("cbc:TaxExemptionReason", null, ex?.name ?? exemption) : null,
      el("cac:TaxScheme", null, [el("cbc:Name", null, "KDV"), el("cbc:TaxTypeCode", null, "0015")]),
    ]),
  ]);
}

function withholdingSubtotal(cur: string, base: number, amount: number, code: string, tenths: number, t: TaxTables): string {
  return el("cac:TaxSubtotal", null, [
    el("cbc:TaxableAmount", { currencyID: cur }, amt(base)),
    el("cbc:TaxAmount", { currencyID: cur }, amt(amount)),
    el("cbc:Percent", null, String(tenths * 10)),
    el("cac:TaxCategory", null, [el("cac:TaxScheme", null, [el("cbc:Name", null, t.withholding.get(code)?.name ?? code), el("cbc:TaxTypeCode", null, code)])]),
  ]);
}

/** Writes the invoice as UBL-TR 1.2 XML. */
export function ublXml(d: InvoiceDocument, t: TaxTables): string {
  const cur = d.currency;
  const T = d.totals;
  const lines = d.lines.map((l, i) =>
    el("cac:InvoiceLine", null, [
      el("cbc:ID", null, String(i + 1)),
      l.description ? el("cbc:Note", null, l.description) : null,
      el("cbc:InvoicedQuantity", { unitCode: l.unit }, qty(l.quantity)),
      el("cbc:LineExtensionAmount", { currencyID: cur }, amt(l.totals.net)),
      l.discount
        ? el("cac:AllowanceCharge", null, [
            el("cbc:ChargeIndicator", null, "false"),
            el("cbc:MultiplierFactorNumeric", null, qty(l.discount / 10)),
            el("cbc:Amount", { currencyID: cur }, amt(l.totals.discountAmount)),
            el("cbc:BaseAmount", { currencyID: cur }, amt(l.totals.gross)),
          ])
        : null,
      el("cac:TaxTotal", null, [
        el("cbc:TaxAmount", { currencyID: cur }, amt(l.totals.kdv)),
        kdvSubtotal(cur, l.totals.net, l.totals.kdv, l.kdvRate, l.exemption, t),
      ]),
      l.withholding
        ? el("cac:WithholdingTaxTotal", null, [
            el("cbc:TaxAmount", { currencyID: cur }, amt(l.totals.withheld)),
            withholdingSubtotal(cur, l.totals.kdv, l.totals.withheld, l.withholding, t.withholding.get(l.withholding)?.tenths ?? 0, t),
          ])
        : null,
      el("cac:Item", null, [el("cbc:Name", null, l.name), l.code ? el("cac:SellersItemIdentification", null, [el("cbc:ID", null, l.code)]) : null]),
      el("cac:Price", null, [el("cbc:PriceAmount", { currencyID: cur }, amt(l.unitPrice))]),
    ]),
  );
  const body = el("Invoice", NS, [
    // The integrator puts its signature here.
    el("ext:UBLExtensions", null, [el("ext:UBLExtension", null, [el("ext:ExtensionContent", null, null)])]),
    el("cbc:UBLVersionID", null, "2.1"),
    el("cbc:CustomizationID", null, "TR1.2"),
    el("cbc:ProfileID", null, d.profile),
    el("cbc:ID", null, d.number),
    el("cbc:CopyIndicator", null, "false"),
    el("cbc:UUID", null, d.uuid),
    el("cbc:IssueDate", null, d.issueDate),
    el("cbc:IssueTime", null, d.issueTime),
    el("cbc:InvoiceTypeCode", null, d.type),
    ...d.notes.map((n) => el("cbc:Note", null, n)),
    el("cbc:DocumentCurrencyCode", null, cur),
    el("cbc:LineCountNumeric", null, String(d.lines.length)),
    d.period ? el("cac:InvoicePeriod", null, [el("cbc:StartDate", null, d.period.start), el("cbc:EndDate", null, d.period.end)]) : null,
    d.orderReference ? el("cac:OrderReference", null, [el("cbc:ID", null, d.orderReference), el("cbc:IssueDate", null, d.issueDate)]) : null,
    d.reference
      ? el("cac:BillingReference", null, [
          el("cac:InvoiceDocumentReference", null, [
            el("cbc:ID", null, d.reference.number),
            el("cbc:IssueDate", null, d.reference.date),
            el("cbc:DocumentTypeCode", null, "IADE"),
          ]),
        ])
      : null,
    d.profile === "EARSIVFATURA"
      ? el("cac:AdditionalDocumentReference", null, [
          el("cbc:ID", null, d.uuid),
          el("cbc:IssueDate", null, d.issueDate),
          el("cbc:DocumentTypeCode", null, "SendingType"),
          el("cbc:DocumentType", null, "ELEKTRONIK"),
        ])
      : null,
    el("cac:Signature", null, [
      el("cbc:ID", { schemeID: "VKN_TCKN" }, d.seller.taxId),
      el("cac:SignatoryParty", null, [
        el("cac:PartyIdentification", null, [el("cbc:ID", { schemeID: d.seller.taxId.length === 11 ? "TCKN" : "VKN" }, d.seller.taxId)]),
        el("cac:PostalAddress", null, [
          el("cbc:CitySubdivisionName", null, d.seller.address.district ?? d.seller.address.city),
          el("cbc:CityName", null, d.seller.address.city),
          el("cac:Country", null, [el("cbc:Name", null, d.seller.address.country)]),
        ]),
      ]),
      el("cac:DigitalSignatureAttachment", null, [el("cac:ExternalReference", null, [el("cbc:URI", null, "#Signature")])]),
    ]),
    el("cac:AccountingSupplierParty", null, [party(d.seller, true)]),
    el("cac:AccountingCustomerParty", null, [party(d.buyer, false)]),
    d.iban || d.dueDate
      ? el("cac:PaymentMeans", null, [
          el("cbc:PaymentMeansCode", null, d.iban ? "42" : "1"),
          d.dueDate ? el("cbc:PaymentDueDate", null, d.dueDate) : null,
          d.iban ? el("cac:PayeeFinancialAccount", null, [el("cbc:ID", null, d.iban), el("cbc:CurrencyCode", null, cur)]) : null,
        ])
      : null,
    d.rate !== null
      ? el("cac:PricingExchangeRate", null, [
          el("cbc:SourceCurrencyCode", null, cur),
          el("cbc:TargetCurrencyCode", null, "TRY"),
          el("cbc:CalculationRate", null, rate4(d.rate)),
        ])
      : null,
    el("cac:TaxTotal", null, [
      el("cbc:TaxAmount", { currencyID: cur }, amt(T.kdv)),
      ...T.kdvBreakdown.map((k) => kdvSubtotal(cur, k.base, k.amount, k.rate, k.exemption, t)),
    ]),
    T.withholdingBreakdown.length
      ? el("cac:WithholdingTaxTotal", null, [
          el("cbc:TaxAmount", { currencyID: cur }, amt(T.withheld)),
          ...T.withholdingBreakdown.map((w) => withholdingSubtotal(cur, w.base, w.amount, w.code, w.tenths, t)),
        ])
      : null,
    el("cac:LegalMonetaryTotal", null, [
      el("cbc:LineExtensionAmount", { currencyID: cur }, amt(T.net)),
      el("cbc:TaxExclusiveAmount", { currencyID: cur }, amt(T.net)),
      el("cbc:TaxInclusiveAmount", { currencyID: cur }, amt(T.total)),
      el("cbc:AllowanceTotalAmount", { currencyID: cur }, amt(T.discount)),
      el("cbc:PayableAmount", { currencyID: cur }, amt(T.payable)),
    ]),
    ...lines,
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}

// UBL 2.1's order of the Invoice's children, for the ones UBL-TR uses.
const ORDER = [
  "UBLExtensions",
  "UBLVersionID",
  "CustomizationID",
  "ProfileID",
  "ID",
  "CopyIndicator",
  "UUID",
  "IssueDate",
  "IssueTime",
  "InvoiceTypeCode",
  "Note",
  "DocumentCurrencyCode",
  "TaxCurrencyCode",
  "PricingCurrencyCode",
  "PaymentCurrencyCode",
  "LineCountNumeric",
  "InvoicePeriod",
  "OrderReference",
  "BillingReference",
  "DespatchDocumentReference",
  "ReceiptDocumentReference",
  "OriginatorDocumentReference",
  "ContractDocumentReference",
  "AdditionalDocumentReference",
  "Signature",
  "AccountingSupplierParty",
  "AccountingCustomerParty",
  "BuyerCustomerParty",
  "SellerSupplierParty",
  "TaxRepresentativeParty",
  "Delivery",
  "PaymentMeans",
  "PaymentTerms",
  "AllowanceCharge",
  "TaxExchangeRate",
  "PricingExchangeRate",
  "PaymentExchangeRate",
  "PaymentAlternativeExchangeRate",
  "TaxTotal",
  "WithholdingTaxTotal",
  "LegalMonetaryTotal",
  "InvoiceLine",
];
const REQUIRED = [
  "UBLVersionID",
  "CustomizationID",
  "ProfileID",
  "ID",
  "CopyIndicator",
  "UUID",
  "IssueDate",
  "InvoiceTypeCode",
  "DocumentCurrencyCode",
  "LineCountNumeric",
  "Signature",
  "AccountingSupplierParty",
  "AccountingCustomerParty",
  "TaxTotal",
  "LegalMonetaryTotal",
  "InvoiceLine",
];
const TYPES = ["SATIS", "IADE", "TEVKIFAT", "ISTISNA", "OZELMATRAH", "IHRACKAYITLI", "SGK", "KOMISYONCU"];
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** "45000.50" as 4500050, or null when it is not an amount with at most two decimals. */
function minorOf(s: string | null): number | null {
  if (s === null || !/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.replace("-", "").split(".");
  return (s.startsWith("-") ? -1 : 1) * (Number(w) * 100 + Number(f.padEnd(2, "0")));
}

/** What is wrong with the XML, as GİB's rules would say it; an empty list when nothing is. */
export function validateUbl(xml: string): string[] {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (err) {
    return [(err as Error).message];
  }
  const p: string[] = [];
  if (root.name !== "Invoice" || root.attrs.xmlns !== NS.xmlns) p.push("The root is Invoice in the UBL Invoice-2 namespace.");
  for (const [k, v] of Object.entries(NS)) if (root.attrs[k] !== v) p.push(`The namespace ${k} is ${v}.`);
  const names = root.children.map(local);
  for (const r of REQUIRED) if (!names.includes(r)) p.push(`${r} is required.`);
  let last = -1;
  for (const n of names) {
    const at = ORDER.indexOf(n);
    if (at < 0) p.push(`${n} is not an element of an Invoice here.`);
    else if (at < last) p.push(`${n} is out of UBL 2.1's order.`);
    else last = at;
  }
  if (textAt(root, "UBLVersionID") !== "2.1") p.push("UBLVersionID is 2.1.");
  if (textAt(root, "CustomizationID") !== "TR1.2") p.push("CustomizationID is TR1.2.");
  const profile = textAt(root, "ProfileID");
  if (!["TEMELFATURA", "TICARIFATURA", "EARSIVFATURA"].includes(profile ?? "")) p.push("ProfileID is TEMELFATURA, TICARIFATURA or EARSIVFATURA.");
  const id = textAt(root, "ID") ?? "";
  const issue = textAt(root, "IssueDate") ?? "";
  if (!/^[A-Z0-9]{3}20\d{2}\d{9}$/.test(id)) p.push("ID is 16 characters: a three-character series, the year and a nine-digit number.");
  else if (id.slice(3, 7) !== issue.slice(0, 4)) p.push("The year in ID is the year of IssueDate.");
  if (/^[A-Z0-9]{3}20\d{2}0{9}$/.test(id)) p.push("The number in ID starts at 000000001.");
  if (!UUID.test(textAt(root, "UUID") ?? "")) p.push("UUID (ETTN) is a UUID.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue)) p.push("IssueDate is YYYY-MM-DD.");
  if (textAt(root, "IssueTime") !== null && !/^\d{2}:\d{2}:\d{2}$/.test(textAt(root, "IssueTime")!)) p.push("IssueTime is HH:MM:SS.");
  const type = textAt(root, "InvoiceTypeCode") ?? "";
  if (!TYPES.includes(type)) p.push(`InvoiceTypeCode is one of ${TYPES.join(", ")}.`);
  const cur = textAt(root, "DocumentCurrencyCode") ?? "";
  if (!/^[A-Z]{3}$/.test(cur)) p.push("DocumentCurrencyCode is an ISO 4217 code.");
  const lines = kids(root, "InvoiceLine");
  if (textAt(root, "LineCountNumeric") !== String(lines.length)) p.push("LineCountNumeric is the number of InvoiceLines.");

  // Every amount is in the document's currency, with two decimals.
  const walk = (n: XmlNode) => {
    if (n.attrs.currencyID !== undefined) {
      if (n.attrs.currencyID !== cur) p.push(`${local(n)} is in ${n.attrs.currencyID}, not the document's ${cur}.`);
      if (minorOf(n.text.trim()) === null) p.push(`${local(n)} is an amount with at most two decimals.`);
    }
    n.children.forEach(walk);
  };
  walk(root);

  if (cur !== "TRY") {
    const x = first(root, "PricingExchangeRate");
    if (!x) p.push("An invoice not in TRY has PricingExchangeRate.");
    else {
      if (textAt(x, "SourceCurrencyCode") !== cur || textAt(x, "TargetCurrencyCode") !== "TRY")
        p.push("PricingExchangeRate is from the document's currency to TRY.");
      if (!(Number(textAt(x, "CalculationRate")) > 0)) p.push("PricingExchangeRate's CalculationRate is above 0.");
    }
  }

  // The parties.
  for (const side of ["AccountingSupplierParty", "AccountingCustomerParty"]) {
    const party = first(root, side, "Party");
    const idNode = kids(party, "PartyIdentification", "ID").find((n) => n.attrs.schemeID === "VKN" || n.attrs.schemeID === "TCKN");
    if (!idNode) {
      p.push(`${side} has a PartyIdentification ID with schemeID VKN or TCKN.`);
      continue;
    }
    const v = idNode.text.trim();
    if (idNode.attrs.schemeID === "VKN" && !/^\d{10}$/.test(v)) p.push(`${side}: a VKN is 10 digits.`);
    if (idNode.attrs.schemeID === "TCKN") {
      if (!/^\d{11}$/.test(v)) p.push(`${side}: a TCKN is 11 digits.`);
      if (!textAt(party, "Person", "FirstName") || !textAt(party, "Person", "FamilyName"))
        p.push(`${side}: a TCKN party has Person with FirstName and FamilyName.`);
    } else if (!textAt(party, "PartyName", "Name")) p.push(`${side}: a VKN party has PartyName.`);
    const addr = first(party, "PostalAddress");
    if (!textAt(addr, "CitySubdivisionName") || !textAt(addr, "CityName") || !textAt(addr, "Country", "Name"))
      p.push(`${side}: PostalAddress has CitySubdivisionName, CityName and Country.`);
    if (side === "AccountingSupplierParty" && !textAt(party, "PartyTaxScheme", "TaxScheme", "Name")) p.push("The supplier's tax office is in PartyTaxScheme.");
  }
  if (
    textAt(root, "Signature", "ID") !==
    kids(root, "AccountingSupplierParty", "Party", "PartyIdentification", "ID")
      .find((n) => n.attrs.schemeID !== "MERSISNO" && n.attrs.schemeID !== "TICARETSICILNO")
      ?.text.trim()
  )
    p.push("Signature's ID is the supplier's VKN or TCKN.");

  // Profile and type.
  const sending = kids(root, "AdditionalDocumentReference").find((n) => textAt(n, "DocumentTypeCode") === "SendingType");
  if (profile === "EARSIVFATURA" && !["ELEKTRONIK", "KAGIT"].includes(textAt(sending, "DocumentType") ?? ""))
    p.push("An e-Arşiv invoice says how it is sent (SendingType ELEKTRONIK or KAGIT).");
  if (profile !== "EARSIVFATURA" && sending) p.push("SendingType is only for e-Arşiv invoices.");
  const ref = first(root, "BillingReference", "InvoiceDocumentReference");
  if (type === "IADE" && (!textAt(ref, "ID") || !textAt(ref, "IssueDate")))
    p.push("An IADE invoice names the invoice it returns in BillingReference, with its ID and IssueDate.");

  // Taxes, line by line, and the sums.
  const withholdingTotal = first(root, "WithholdingTaxTotal");
  if (type === "TEVKIFAT" && !withholdingTotal) p.push("A TEVKIFAT invoice has WithholdingTaxTotal.");
  if (type !== "TEVKIFAT" && type !== "IADE" && withholdingTotal) p.push("Only a TEVKIFAT invoice has WithholdingTaxTotal.");
  const subtotals = (n: XmlNode | undefined) => kids(n, "TaxSubtotal");
  const checkKdv = (sub: XmlNode, at: string) => {
    const percent = Number(textAt(sub, "Percent"));
    const base = minorOf(textAt(sub, "TaxableAmount"));
    const tax = minorOf(textAt(sub, "TaxAmount"));
    if (textAt(sub, "TaxCategory", "TaxScheme", "TaxTypeCode") !== "0015") p.push(`${at}: KDV's TaxTypeCode is 0015.`);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) p.push(`${at}: Percent is 0 to 100.`);
    if (base !== null && tax !== null && Math.abs(mulDiv(base, Math.round(percent * 100), 10000) - tax) > 1)
      p.push(`${at}: TaxAmount is TaxableAmount times Percent.`);
    const code = textAt(sub, "TaxCategory", "TaxExemptionReasonCode");
    if (percent === 0 && !code) p.push(`${at}: 0% KDV needs TaxExemptionReasonCode.`);
    if (percent > 0 && code) p.push(`${at}: TaxExemptionReasonCode is only for 0% KDV.`);
    if (type === "ISTISNA" && percent !== 0) p.push(`${at}: an ISTISNA invoice has 0% KDV.`);
    return { tax: tax ?? 0, base: base ?? 0 };
  };
  const checkWithholding = (sub: XmlNode, at: string) => {
    const code = textAt(sub, "TaxCategory", "TaxScheme", "TaxTypeCode") ?? "";
    const percent = Number(textAt(sub, "Percent"));
    const base = minorOf(textAt(sub, "TaxableAmount"));
    const tax = minorOf(textAt(sub, "TaxAmount"));
    if (!/^[68]\d{2}$/.test(code)) p.push(`${at}: a withholding TaxTypeCode is a 6xx or 8xx code.`);
    if (!(percent > 0 && percent <= 100)) p.push(`${at}: the withholding Percent is above 0 and at most 100.`);
    if (base !== null && tax !== null && Math.abs(mulDiv(base, Math.round(percent * 100), 10000) - tax) > 1)
      p.push(`${at}: the withheld TaxAmount is the KDV times Percent.`);
    return tax ?? 0;
  };
  let sumNet = 0;
  let sumKdv = 0;
  let sumWithheld = 0;
  lines.forEach((l, i) => {
    const at = `InvoiceLine ${i + 1}`;
    const q = Number(textAt(l, "InvoicedQuantity"));
    const unit = first(l, "InvoicedQuantity")?.attrs.unitCode;
    if (!(q > 0)) p.push(`${at}: InvoicedQuantity is above 0.`);
    if (!unit) p.push(`${at}: InvoicedQuantity has a unitCode.`);
    if (!textAt(l, "Item", "Name")) p.push(`${at}: Item has a Name.`);
    const price = minorOf(textAt(l, "Price", "PriceAmount"));
    const ext = minorOf(textAt(l, "LineExtensionAmount"));
    const allowance = kids(l, "AllowanceCharge")
      .filter((a) => textAt(a, "ChargeIndicator") === "false")
      .reduce((s, a) => s + (minorOf(textAt(a, "Amount")) ?? 0), 0);
    if (price !== null && ext !== null && Math.abs(Math.round(q * price) - allowance - ext) > 1)
      p.push(`${at}: LineExtensionAmount is quantity times price, less the discount.`);
    sumNet += ext ?? 0;
    const tt = first(l, "TaxTotal");
    if (!tt) p.push(`${at}: TaxTotal is required.`);
    let lineKdv = 0;
    for (const s of subtotals(tt)) lineKdv += checkKdv(s, at).tax;
    if (tt && minorOf(textAt(tt, "TaxAmount")) !== lineKdv) p.push(`${at}: TaxTotal's TaxAmount is the sum of its TaxSubtotals.`);
    sumKdv += lineKdv;
    const wt = first(l, "WithholdingTaxTotal");
    if (wt) {
      let w = 0;
      for (const s of subtotals(wt)) w += checkWithholding(s, at);
      if (minorOf(textAt(wt, "TaxAmount")) !== w) p.push(`${at}: WithholdingTaxTotal's TaxAmount is the sum of its TaxSubtotals.`);
      sumWithheld += w;
    }
  });
  const tt = first(root, "TaxTotal");
  let docKdv = 0;
  for (const s of subtotals(tt)) docKdv += checkKdv(s, "TaxTotal").tax;
  if (minorOf(textAt(tt, "TaxAmount")) !== docKdv) p.push("TaxTotal's TaxAmount is the sum of its TaxSubtotals.");
  if (docKdv !== sumKdv) p.push("TaxTotal is the sum of the lines' KDV.");
  let docWithheld = 0;
  for (const s of subtotals(withholdingTotal)) docWithheld += checkWithholding(s, "WithholdingTaxTotal");
  if (withholdingTotal && minorOf(textAt(withholdingTotal, "TaxAmount")) !== docWithheld)
    p.push("WithholdingTaxTotal's TaxAmount is the sum of its TaxSubtotals.");
  if (docWithheld !== sumWithheld) p.push("WithholdingTaxTotal is the sum of the lines' withholding.");
  const m = first(root, "LegalMonetaryTotal");
  const lmt = (k: string) => minorOf(textAt(m, k));
  if (lmt("LineExtensionAmount") !== sumNet) p.push("LegalMonetaryTotal's LineExtensionAmount is the sum of the lines.");
  if (lmt("TaxExclusiveAmount") !== sumNet) p.push("TaxExclusiveAmount is the lines' sum without KDV.");
  if (lmt("TaxInclusiveAmount") !== sumNet + docKdv) p.push("TaxInclusiveAmount is TaxExclusiveAmount plus KDV.");
  if (lmt("PayableAmount") !== sumNet + docKdv - docWithheld) p.push("PayableAmount is TaxInclusiveAmount less the withheld KDV.");
  return [...new Set(p)];
}
