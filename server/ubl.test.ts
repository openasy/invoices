// The UBL-TR XML as GİB reads it: the elements and their order, the parties, the taxes, and the sums to the kuruş. Each
// rule validateUbl checks is broken once here to see it caught.
import { describe, expect, it } from "vitest";
import { DEFAULT_TABLES, invoiceTotals, typeCode, type LineInput } from "./tax.ts";
import { amt, qty, rate4, splitName, ublXml, validateUbl, type InvoiceDocument } from "./ubl.ts";
import { first, kids, local, parseXml, textAt } from "./xml.ts";

const SELLER = {
  name: "Acme Yazılım A.Ş.",
  taxId: "1234567890",
  taxOffice: "Zincirlikuyu",
  address: { street: "Büyükdere Cad. No:1", district: "Şişli", city: "İstanbul", postalCode: "34394", country: "Türkiye" },
  email: "fatura@acme.example",
  phone: null,
  mersis: "0123456789000015",
};
const BUYER = {
  name: "Yıldız Mimarlık Ltd. Şti.",
  taxId: "9876543210",
  taxOffice: "Kordon",
  address: { street: "Atatürk Cad. 12", district: "Konak", city: "İzmir", postalCode: "35210", country: "Türkiye" },
  email: "muhasebe@yildiz.example",
  phone: null,
};

function doc(lines: Array<Partial<LineInput> & { name?: string }>, over: Partial<InvoiceDocument> = {}): InvoiceDocument {
  const inputs: LineInput[] = lines.map((l) => ({
    quantity: 1000,
    unitPrice: 100000,
    discount: 0,
    kdvRate: 20,
    withholding: null,
    withholdingTenths: 0,
    exemption: null,
    ...l,
  }));
  const t = invoiceTotals(inputs);
  return {
    uuid: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    number: "ACM2026000000001",
    profile: "TEMELFATURA",
    type: typeCode(inputs, false),
    issueDate: "2026-11-02",
    issueTime: "09:00:00",
    dueDate: "2026-12-02",
    currency: "TRY",
    rate: null,
    seller: SELLER,
    buyer: BUYER,
    lines: inputs.map((l, i) => ({ ...l, name: lines[i]!.name ?? `Hizmet ${i + 1}`, code: null, description: null, unit: "C62", totals: t.lines[i]! })),
    totals: t,
    notes: ["Ödeme 30 gün içinde."],
    reference: null,
    period: null,
    orderReference: null,
    iban: "TR330006100519786457841326",
    ...over,
  };
}

const xmlOf = (d: InvoiceDocument) => ublXml(d, DEFAULT_TABLES);

describe("UBL-TR 1.2", () => {
  it("writes a SATIS e-Fatura that passes every check", () => {
    const d = doc([{ name: "Yazılım lisansı, 12 ay", quantity: 2000, unitPrice: 4500050, discount: 1000 }, { kdvRate: 10 }]);
    const xml = xmlOf(d);
    expect(validateUbl(xml)).toEqual([]);
    const root = parseXml(xml);
    expect(root.children.map(local).slice(0, 11)).toEqual([
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
    ]);
    expect(textAt(root, "CustomizationID")).toBe("TR1.2");
    expect(textAt(root, "InvoiceTypeCode")).toBe("SATIS");
    expect(textAt(root, "AccountingSupplierParty", "Party", "PartyName", "Name")).toBe("Acme Yazılım A.Ş.");
    expect(kids(root, "AccountingSupplierParty", "Party", "PartyIdentification", "ID").map((n) => n.attrs.schemeID)).toEqual(["VKN", "MERSISNO"]);
    expect(textAt(root, "AccountingCustomerParty", "Party", "PostalAddress", "CitySubdivisionName")).toBe("Konak");
    const line1 = kids(root, "InvoiceLine")[0]!;
    // 2 × 45.000,50 = 90.001,00, less 10% = 81.000,90; KDV 20% = 16.200,18.
    expect(textAt(line1, "LineExtensionAmount")).toBe("81000.90");
    expect(textAt(line1, "AllowanceCharge", "Amount")).toBe("9000.10");
    expect(textAt(line1, "TaxTotal", "TaxAmount")).toBe("16200.18");
    expect(textAt(root, "LegalMonetaryTotal", "PayableAmount")).toBe(amt(d.totals.payable));
    expect(kids(root, "TaxTotal", "TaxSubtotal").map((s) => textAt(s, "Percent"))).toEqual(["20", "10"]);
    expect(textAt(root, "PaymentMeans", "PayeeFinancialAccount", "ID")).toBe("TR330006100519786457841326");
  });

  it("writes TEVKIFAT with the withheld KDV per line and in total, and PayableAmount less it", () => {
    const d = doc([{ unitPrice: 1000000, withholding: "602", withholdingTenths: 9 }]);
    const xml = xmlOf(d);
    expect(validateUbl(xml)).toEqual([]);
    const root = parseXml(xml);
    expect(textAt(root, "InvoiceTypeCode")).toBe("TEVKIFAT");
    const w = first(root, "WithholdingTaxTotal")!;
    expect(textAt(w, "TaxAmount")).toBe("1800.00");
    expect(textAt(w, "TaxSubtotal", "Percent")).toBe("90");
    expect(textAt(w, "TaxSubtotal", "TaxCategory", "TaxScheme", "TaxTypeCode")).toBe("602");
    expect(textAt(root, "LegalMonetaryTotal", "TaxInclusiveAmount")).toBe("12000.00");
    expect(textAt(root, "LegalMonetaryTotal", "PayableAmount")).toBe("10200.00");
  });

  it("writes ISTISNA with the exemption code, and a person as buyer of an e-Arşiv invoice", () => {
    const person = { ...BUYER, name: "Gülşen Öztürk Çağlar", taxId: "10000000146", taxOffice: null };
    const xml = xmlOf(doc([{ kdvRate: 0, exemption: "302" }], { profile: "EARSIVFATURA", buyer: person, type: "ISTISNA", number: "ACA2026000000001" }));
    expect(validateUbl(xml)).toEqual([]);
    const root = parseXml(xml);
    expect(textAt(root, "TaxTotal", "TaxSubtotal", "TaxCategory", "TaxExemptionReasonCode")).toBe("302");
    expect(textAt(root, "AccountingCustomerParty", "Party", "Person", "FirstName")).toBe("Gülşen Öztürk");
    expect(textAt(root, "AccountingCustomerParty", "Party", "Person", "FamilyName")).toBe("Çağlar");
    expect(first(root, "AccountingCustomerParty", "Party", "PartyName")).toBeUndefined();
    expect(kids(root, "AdditionalDocumentReference").find((n) => textAt(n, "DocumentTypeCode") === "SendingType")).toBeDefined();
  });

  it("writes IADE with the invoice it returns", () => {
    const xml = xmlOf(
      doc([{}], { type: "IADE", number: "ACM2026000000002", reference: { number: "ACM2026000000001", date: "2026-11-02" }, iban: null, dueDate: null }),
    );
    expect(validateUbl(xml)).toEqual([]);
    expect(textAt(parseXml(xml), "BillingReference", "InvoiceDocumentReference", "ID")).toBe("ACM2026000000001");
  });

  it("writes a foreign currency invoice with TCMB's rate", () => {
    const xml = xmlOf(doc([{ unitPrice: 250000 }], { currency: "EUR", rate: 371050 }));
    expect(validateUbl(xml)).toEqual([]);
    const root = parseXml(xml);
    expect(textAt(root, "PricingExchangeRate", "CalculationRate")).toBe("37.1050");
    expect(first(root, "LegalMonetaryTotal", "PayableAmount")!.attrs.currencyID).toBe("EUR");
  });

  it("catches what GİB would refuse", () => {
    const good = xmlOf(doc([{}]));
    const broken: Array<[string, string, RegExp]> = [
      ["the number", good.replace("<cbc:ID>ACM2026000000001</cbc:ID>", "<cbc:ID>ACM-2026-1</cbc:ID>"), /16 characters/],
      ["the year", good.replace("<cbc:ID>ACM2026000000001</cbc:ID>", "<cbc:ID>ACM2025000000001</cbc:ID>"), /year in ID/],
      ["number zero", good.replace("<cbc:ID>ACM2026000000001</cbc:ID>", "<cbc:ID>ACM2026000000000</cbc:ID>"), /starts at 000000001/],
      ["the ETTN", good.replace(/<cbc:UUID>[^<]+/, "<cbc:UUID>nope"), /UUID/],
      ["a sum", good.replace(/<cbc:PayableAmount currencyID="TRY">[^<]+/, '<cbc:PayableAmount currencyID="TRY">1.00'), /PayableAmount/],
      ["a line's KDV", good.replace(/(<cac:InvoiceLine>[\s\S]*?<cbc:TaxAmount currencyID="TRY">)[^<]+/, "$1199.00"), /TaxAmount|sum of the lines/],
      ["the currency of an amount", good.replace('<cbc:PayableAmount currencyID="TRY">', '<cbc:PayableAmount currencyID="EUR">'), /in EUR/],
      ["the order", good.replace(/(<cbc:CopyIndicator>false<\/cbc:CopyIndicator>)(<cbc:UUID>[^<]+<\/cbc:UUID>)/, "$2$1"), /out of UBL 2.1's order/],
      ["the VKN", good.replace('<cbc:ID schemeID="VKN">9876543210</cbc:ID>', '<cbc:ID schemeID="VKN">98765</cbc:ID>'), /VKN is 10 digits/],
      ["the line count", good.replace("<cbc:LineCountNumeric>1</cbc:LineCountNumeric>", "<cbc:LineCountNumeric>2</cbc:LineCountNumeric>"), /LineCountNumeric/],
      ["well-formedness", good.replace("</Invoice>", ""), /not closed/],
    ];
    for (const [what, xml, re] of broken) expect(validateUbl(xml).join(" "), what).toMatch(re);
    expect(validateUbl(xmlOf(doc([{ kdvRate: 0, exemption: null }]))).join(" ")).toMatch(/TaxExemptionReasonCode/);
    expect(validateUbl(xmlOf(doc([{}], { currency: "USD", rate: null }))).join(" ")).toMatch(/PricingExchangeRate/);
    expect(validateUbl(xmlOf(doc([{}], { type: "IADE" }))).join(" ")).toMatch(/BillingReference/);
    expect(validateUbl(xmlOf(doc([{}], { type: "TEVKIFAT" }))).join(" ")).toMatch(/WithholdingTaxTotal/);
    expect(
      validateUbl(
        xmlOf(doc([{}], { profile: "EARSIVFATURA" })).replace(/<cac:AdditionalDocumentReference>[\s\S]*?<\/cac:AdditionalDocumentReference>/, ""),
      ).join(" "),
    ).toMatch(/SendingType/);
  });

  it("writes amounts, quantities and rates as UBL does", () => {
    expect(amt(4500050)).toBe("45000.50");
    expect(amt(5)).toBe("0.05");
    expect(amt(-120)).toBe("-1.20");
    expect(qty(1500)).toBe("1.5");
    expect(qty(2000)).toBe("2");
    expect(qty(1)).toBe("0.001");
    expect(rate4(342512)).toBe("34.2512");
    expect(splitName("Cher")).toEqual({ first: "Cher", family: "Cher" });
  });
});
