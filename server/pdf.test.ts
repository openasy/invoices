// The invoice PDF read back with pdf.js, as a PDF reader would: every Turkish letter is there as text, KDV is shown
// by rate, the withheld KDV and what is payable are on lines of their own, and the amount is written in words.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { formatMoney, invoicePdf } from "./pdf.ts";
import { DEFAULT_TABLES, invoiceTotals, type LineInput } from "./tax.ts";
import type { InvoiceDocument } from "./ubl.ts";

async function textOf(pdf: Buffer): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((x) => ("str" in x ? x.str : "")).join(" "));
  }
  return pages;
}

function invoice(inputs: Array<LineInput & { name: string }>, over: Partial<InvoiceDocument> = {}): InvoiceDocument {
  const t = invoiceTotals(inputs);
  return {
    uuid: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    number: "ACM2026000000042",
    profile: "TEMELFATURA",
    type: "TEVKIFAT",
    issueDate: "2026-11-02",
    issueTime: "09:15:00",
    dueDate: "2026-12-02",
    currency: "TRY",
    rate: null,
    seller: {
      name: "Acme Yazılım A.Ş.",
      taxId: "1234567890",
      taxOffice: "Zincirlikuyu",
      address: { street: "Büyükdere Cad. No:1", district: "Şişli", city: "İstanbul", postalCode: "34394", country: "Türkiye" },
      email: "fatura@acme.example",
      phone: null,
    },
    buyer: {
      name: "Iğdır Çağrı Merkezi Öğretim Şirketi",
      taxId: "9876543210",
      taxOffice: "Kordon",
      address: { street: "Gül Sok. 3", district: "Konak", city: "İzmir", postalCode: null, country: "Türkiye" },
      email: null,
      phone: null,
    },
    lines: inputs.map((l, i) => ({ ...l, code: null, description: null, unit: "HUR", totals: t.lines[i]! })),
    totals: t,
    notes: ["ÜRETİM, ĞÜŞÇÖ: ödeme şartları ekte."],
    reference: null,
    period: null,
    orderReference: null,
    iban: "TR330006100519786457841326",
    ...over,
  };
}

const L = (o: Partial<LineInput> & { name: string }): LineInput & { name: string } => ({
  quantity: 1000,
  unitPrice: 100000,
  discount: 0,
  kdvRate: 20,
  withholding: null,
  withholdingTenths: 0,
  exemption: null,
  ...o,
});

describe("invoice PDF", () => {
  it("draws every Turkish letter as text, with the KDV, the withholding and the amount in words", async () => {
    const d = invoice([
      L({ name: "Danışmanlık hizmeti, Şubat", quantity: 10000, unitPrice: 100000, withholding: "602", withholdingTenths: 9 }),
      L({ name: "Eğitim", kdvRate: 10 }),
    ]);
    const pdf = await invoicePdf({ doc: d, tables: DEFAULT_TABLES, language: "tr", draft: false, balance: null, bank: "Örnek Bankası", footer: null });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = (await textOf(pdf)).join(" ");
    for (const s of [
      "e-Fatura",
      "ACM2026000000042",
      "Acme Yazılım A.Ş.",
      "Iğdır Çağrı Merkezi Öğretim Şirketi",
      "Danışmanlık hizmeti, Şubat",
      "ÜRETİM, ĞÜŞÇÖ",
      "ETTN",
    ])
      expect(text).toContain(s);
    for (const letter of "çğıİöşüÇĞÖŞÜ") expect(text).toContain(letter);
    // 10 × 1.000 = 10.000 at 20% (2.000, of which 9/10 withheld) and 1.000 at 10% (100).
    expect(text).toContain("Hesaplanan KDV %20");
    expect(text).toContain("2.000,00 TL");
    expect(text).toContain("KDV tevkifatı 602, 9/10");
    expect(text).toContain("-1.800,00 TL");
    expect(text).toContain("13.100,00 TL");
    expect(text).toContain("Ödenecek tutar");
    expect(text).toContain("11.300,00 TL");
    expect(text).toContain("Yalnız on bir bin üç yüz Türk lirası");
    expect(text).toContain("TR33 0006 1005 1978 6457 8413 26");
    expect(text).toContain("Saat");
    expect(text).toContain("Birim fiyat");
  });

  it("marks a draft, writes e-Arşiv's note, and shows the TRY value of a foreign invoice", async () => {
    const d = invoice([L({ name: "License", unitPrice: 250000 })], { profile: "EARSIVFATURA", type: "SATIS", currency: "EUR", rate: 371050 });
    const text = (
      await textOf(await invoicePdf({ doc: d, tables: DEFAULT_TABLES, language: "tr", draft: true, balance: null, bank: null, footer: null }))
    ).join(" ");
    expect(text).toContain("TASLAK");
    expect(text).toContain("e-Arşiv izni kapsamında elektronik ortamda iletilmiştir.");
    expect(text).toContain("1 EUR = 37,105 TL");
    expect(text).toContain("TL karşılığı");
    expect(text).toContain("111.315,00 TL");
  });

  it("is written in English when the file says so, and runs onto more pages", async () => {
    const many = invoice(
      Array.from({ length: 70 }, (_x, i) => L({ name: `Line ${i + 1}`, discount: 1000 })),
      { type: "SATIS" },
    );
    const pages = await textOf(await invoicePdf({ doc: many, tables: DEFAULT_TABLES, language: "en", draft: false, balance: 1000, bank: null, footer: null }));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join(" ")).toContain("Still owed");
    expect(pages.at(-1)).toContain(`Page ${pages.length} of ${pages.length}`);
  });

  it("writes amounts as each language does, TRY as TL", () => {
    expect(formatMoney(4500050, "TRY", "tr")).toBe("45.000,50 TL");
    expect(formatMoney(4500050, "TRY", "en")).toBe("45,000.50 TL");
  });
});
