// The invoice as PDF, made on the server with PDFKit, for the customer's email and for printing. The text is set in
// DejaVu Sans, embedded in the file, because the PDF's built-in fonts have no ğ, ı, İ or ş: with an embedded font
// every Turkish letter is drawn and can be copied and searched. The legal invoice is the UBL-TR XML at GİB; this is
// its copy, with the same number, ETTN, lines and totals.
import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import type { Language } from "./config.ts";
import type { TaxTables } from "./tax.ts";
import { UNITS, type InvoiceDocument } from "./ubl.ts";
import { amountInWords } from "./words.ts";

const require = createRequire(import.meta.url);
const FONT = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");

export interface PdfInput {
  doc: InvoiceDocument;
  tables: TaxTables;
  language: Language;
  /** A draft has no number yet and is printed TASLAK across. */
  draft: boolean;
  /** What is still owed, when some is paid. */
  balance: number | null;
  bank: string | null;
  footer: string | null;
}

const WORDS: Record<Language, Record<string, string>> = {
  tr: {
    efatura: "e-Fatura",
    earsiv: "e-Arşiv Fatura",
    draft: "TASLAK",
    creditNote: "İade faturası",
    number: "Fatura no",
    date: "Fatura tarihi",
    time: "Saat",
    due: "Son ödeme",
    ettn: "ETTN",
    scenario: "Senaryo",
    type: "Fatura tipi",
    rate: "Döviz kuru (TCMB)",
    reference: "İade edilen fatura",
    order: "Sipariş no",
    period: "Dönem",
    to: "Sayın",
    vkn: "VKN",
    tckn: "TCKN",
    taxOffice: "Vergi dairesi",
    mersis: "MERSİS no",
    registry: "Ticaret sicil no",
    pos: "Sıra",
    item: "Mal / hizmet",
    qty: "Miktar",
    unit: "Birim fiyat",
    discount: "İskonto",
    kdv: "KDV",
    amount: "Tutar",
    gross: "Mal / hizmet toplamı",
    totalDiscount: "Toplam iskonto",
    net: "Vergi hariç tutar",
    kdvLine: "Hesaplanan KDV %{rate} (matrah {base})",
    exempt: "KDV %0, istisna {code}",
    withholding: "KDV tevkifatı {code}, {share} (KDV {base})",
    total: "Vergiler dahil toplam",
    payable: "Ödenecek tutar",
    tryValue: "TL karşılığı",
    balance: "Kalan borç",
    notes: "Notlar",
    pay: "Ödeme: {bank} IBAN {iban}",
    earsivNote: "e-Arşiv izni kapsamında elektronik ortamda iletilmiştir.",
    efaturaNote: "Bu belge e-Fatura olarak GİB üzerinden iletilmiştir; yasal belge UBL-TR XML dosyasıdır.",
    page: "Sayfa {n} / {of}",
  },
  en: {
    efatura: "e-Invoice (e-Fatura)",
    earsiv: "e-Archive invoice (e-Arşiv)",
    draft: "DRAFT",
    creditNote: "Credit note (İade)",
    number: "Invoice no",
    date: "Date",
    time: "Time",
    due: "Due",
    ettn: "ETTN",
    scenario: "Profile",
    type: "Type",
    rate: "Exchange rate (TCMB)",
    reference: "Corrects invoice",
    order: "Order no",
    period: "Period",
    to: "To",
    vkn: "Tax no",
    tckn: "ID no",
    taxOffice: "Tax office",
    mersis: "MERSİS no",
    registry: "Trade registry no",
    pos: "#",
    item: "Item",
    qty: "Qty",
    unit: "Unit price",
    discount: "Discount",
    kdv: "KDV",
    amount: "Amount",
    gross: "Items",
    totalDiscount: "Discounts",
    net: "Without KDV",
    kdvLine: "KDV {rate}% (on {base})",
    exempt: "KDV 0%, exemption {code}",
    withholding: "KDV withheld {code}, {share} (of {base})",
    total: "Total with KDV",
    payable: "Payable",
    tryValue: "In TRY",
    balance: "Still owed",
    notes: "Notes",
    pay: "Pay to: {bank} IBAN {iban}",
    earsivNote: "Sent electronically under the e-Arşiv permit.",
    efaturaNote: "Sent through GİB as an e-Fatura; the legal invoice is the UBL-TR XML file.",
    page: "Page {n} of {of}",
  },
};

const LOCALE: Record<Language, string> = { tr: "tr-TR", en: "en-GB" };

/** 4500050 kuruş is 45.000,50 TL in Turkish and 45,000.50 TL in English. TRY is written TL, as people write it. */
export function formatMoney(minor: number, currency: string, language: Language): string {
  const n = new Intl.NumberFormat(LOCALE[language], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
  return `${n} ${currency === "TRY" ? "TL" : currency}`;
}

const num = (n: number, language: Language, digits = 3) => new Intl.NumberFormat(LOCALE[language], { maximumFractionDigits: digits }).format(n);

function formatDate(day: string, language: Language) {
  const [y, m, d] = day.split("-");
  return language === "tr" ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
}

export function invoicePdf(input: PdfInput): Promise<Buffer> {
  const { doc: d, tables, language } = input;
  const w = (key: string, vars: Record<string, string | number> = {}) => WORDS[language][key]!.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ""));
  const money = (minor: number) => formatMoney(minor, d.currency, language);
  const percent = (n: number) => (language === "tr" ? `%${num(n, language, 2)}` : `${num(n, language, 2)}%`);
  const title = d.type === "IADE" ? w("creditNote") : d.profile === "EARSIVFATURA" ? w("earsiv") : w("efatura");
  const pdf = new PDFDocument({
    size: "A4",
    margins: { top: 45, bottom: 60, left: 45, right: 45 },
    bufferPages: true,
    lang: language,
    info: { Title: `${title} ${input.draft ? w("draft") : d.number}`, Author: d.seller.name, Subject: d.buyer.name, Creator: "OpenAsy Invoices" },
  });
  pdf.registerFont("text", FONT);
  pdf.registerFont("bold", BOLD);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  const left = pdf.page.margins.left;
  const width = pdf.page.width - left - pdf.page.margins.right;
  const muted = "#555555";
  const addressLines = (p: InvoiceDocument["seller"]) =>
    [
      p.address.street,
      [p.address.postalCode, p.address.district, p.address.city].filter(Boolean).join(" ") + (p.address.country !== "Türkiye" ? `, ${p.address.country}` : ""),
      [`${p.taxId.length === 11 ? w("tckn") : w("vkn")}: ${p.taxId}`, p.taxOffice && `${w("taxOffice")}: ${p.taxOffice}`].filter(Boolean).join(" · "),
      [p.mersis && `${w("mersis")}: ${p.mersis}`, p.tradeRegistry && `${w("registry")}: ${p.tradeRegistry}`].filter(Boolean).join(" · ") || null,
      [p.email, p.phone, p.website].filter(Boolean).join(" · ") || null,
    ].filter((l): l is string => !!l);

  // The seller on the left; what the invoice is on the right.
  pdf
    .font("bold")
    .fontSize(13)
    .fillColor("#000000")
    .text(d.seller.name, left, 45, { width: width * 0.55 });
  pdf.font("text").fontSize(8).fillColor(muted);
  for (const l of addressLines(d.seller)) pdf.text(l, { width: width * 0.55 });
  const sellerBottom = pdf.y;

  const rx = left + width * 0.55;
  const rw = width * 0.45;
  pdf.font("bold").fontSize(16).fillColor("#000000").text(title, rx, 45, { width: rw, align: "right" });
  pdf.font("text").fontSize(8.5).fillColor(muted);
  const facts: Array<[string, string]> = [
    [w("number"), input.draft ? w("draft") : d.number],
    [w("date"), `${formatDate(d.issueDate, language)} ${d.issueTime.slice(0, 5)}`],
    ...(d.dueDate ? ([[w("due"), formatDate(d.dueDate, language)]] as Array<[string, string]>) : []),
    [w("scenario"), d.profile],
    [w("type"), d.type],
    ...(d.rate !== null ? ([[w("rate"), `1 ${d.currency} = ${num(d.rate / 10000, language, 4)} TL`]] as Array<[string, string]>) : []),
    ...(d.reference ? ([[w("reference"), `${d.reference.number} (${formatDate(d.reference.date, language)})`]] as Array<[string, string]>) : []),
    ...(d.orderReference ? ([[w("order"), d.orderReference]] as Array<[string, string]>) : []),
    ...(d.period ? ([[w("period"), `${formatDate(d.period.start, language)} - ${formatDate(d.period.end, language)}`]] as Array<[string, string]>) : []),
    [w("ettn"), d.uuid],
  ];
  for (const [k, v] of facts) pdf.text(`${k}: ${v}`, rx, pdf.y, { width: rw, align: "right" });

  let y = Math.max(sellerBottom, pdf.y) + 16;
  pdf
    .moveTo(left, y)
    .lineTo(left + width, y)
    .lineWidth(0.5)
    .strokeColor("#cccccc")
    .stroke();
  y += 10;
  pdf.font("text").fontSize(8).fillColor(muted).text(w("to"), left, y);
  pdf
    .font("bold")
    .fontSize(10.5)
    .fillColor("#000000")
    .text(d.buyer.name, left, pdf.y, { width: width * 0.7 });
  pdf.font("text").fontSize(8.5).fillColor("#000000");
  for (const l of addressLines(d.buyer)) pdf.text(l, { width: width * 0.7 });
  pdf.moveDown(1);

  // The lines.
  const anyDiscount = d.lines.some((l) => l.discount > 0);
  const cols = [
    { key: "pos", w: 0.05, align: "left" as const },
    { key: "item", w: anyDiscount ? 0.33 : 0.42, align: "left" as const },
    { key: "qty", w: 0.12, align: "right" as const },
    { key: "unit", w: 0.15, align: "right" as const },
    ...(anyDiscount ? [{ key: "discount", w: 0.09, align: "right" as const }] : []),
    { key: "kdv", w: 0.09, align: "right" as const },
    { key: "amount", w: 0.17, align: "right" as const },
  ];
  const pad = 3.5;
  const row = (cells: string[], bold: boolean, shade: boolean) => {
    pdf.font(bold ? "bold" : "text").fontSize(8);
    const h = Math.max(...cells.map((c, i) => pdf.heightOfString(c, { width: cols[i]!.w * width - 2 * pad }))) + 2 * pad;
    if (pdf.y + h > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
    const top = pdf.y;
    if (shade) pdf.rect(left, top, width, h).fill("#f2f2f2");
    let x = left;
    cells.forEach((c, i) => {
      pdf.fillColor("#000000").text(c, x + pad, top + pad, { width: cols[i]!.w * width - 2 * pad, align: cols[i]!.align });
      x += cols[i]!.w * width;
    });
    pdf.y = top + h;
    pdf
      .moveTo(left, pdf.y)
      .lineTo(left + width, pdf.y)
      .lineWidth(0.3)
      .strokeColor("#dddddd")
      .stroke();
  };
  row(
    cols.map((c) => w(c.key)),
    true,
    true,
  );
  d.lines.forEach((l, i) => {
    const unitName = UNITS[l.unit]?.[language] ?? l.unit;
    const item = [l.name, l.code ? `(${l.code})` : null].filter(Boolean).join(" ") + (l.description ? `\n${l.description}` : "");
    const cells = [String(i + 1), item, `${num(l.quantity / 1000, language)} ${unitName}`, money(l.unitPrice)];
    if (anyDiscount) cells.push(l.discount ? percent(l.discount / 100) : "");
    cells.push(percent(l.kdvRate), money(l.totals.net));
    row(cells, false, false);
  });

  // The totals: KDV by rate, withholding by code, what is paid.
  pdf.moveDown(0.8);
  const T = d.totals;
  const totals: Array<[string, string, boolean]> = [[w("gross"), money(T.gross), false]];
  if (T.discount) totals.push([w("totalDiscount"), money(T.discount), false]);
  totals.push([w("net"), money(T.net), false]);
  for (const k of T.kdvBreakdown)
    totals.push([
      k.exemption
        ? w("exempt", { code: `${k.exemption} ${tables.exemptions.get(k.exemption)?.name ?? ""}`.trim() })
        : w("kdvLine", { rate: k.rate, base: money(k.base) }),
      money(k.amount),
      false,
    ]);
  for (const x of T.withholdingBreakdown)
    totals.push([w("withholding", { code: x.code, share: `${x.tenths}/10`, base: money(x.base) }), `-${money(x.amount)}`, false]);
  totals.push([w("total"), money(T.total), !T.withheld]);
  if (T.withheld) totals.push([w("payable"), money(T.payable), true]);
  if (d.rate !== null) totals.push([w("tryValue"), formatMoney(Math.round((T.payable * d.rate) / 10000), "TRY", language), false]);
  if (input.balance !== null) totals.push([w("balance"), money(input.balance), true]);
  for (const [label, value, strong] of totals) {
    pdf.font(strong ? "bold" : "text").fontSize(strong ? 10 : 8.5);
    const h = Math.max(pdf.heightOfString(label, { width: width * 0.5 }), 12) + 2;
    if (pdf.y + h > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
    const top = pdf.y;
    pdf.fillColor("#000000").text(label, left + width * 0.25, top, { width: width * 0.5, align: "right" });
    pdf.text(value, left + width * 0.75, top, { width: width * 0.25, align: "right" });
    pdf.y = top + h;
  }
  pdf.moveDown(0.6);
  pdf.font("text").fontSize(8.5).fillColor("#000000").text(amountInWords(T.payable, d.currency), left, pdf.y, { width });

  for (const n of d.notes) {
    pdf.moveDown(0.5);
    pdf.font("text").fontSize(8).fillColor(muted).text(n, { width });
  }
  const iban = d.iban;
  if (iban) {
    pdf.moveDown(0.5);
    pdf
      .font("text")
      .fontSize(8.5)
      .fillColor("#000000")
      .text(w("pay", { bank: input.bank ?? "", iban: iban.replace(/(.{4})/g, "$1 ").trim() }), { width });
  }
  pdf.moveDown(0.8);
  pdf
    .font("text")
    .fontSize(7.5)
    .fillColor(muted)
    .text(d.profile === "EARSIVFATURA" ? w("earsivNote") : w("efaturaNote"), { width });
  if (input.footer) pdf.text(input.footer, { width });

  // A draft is marked across every page; page numbers once every page exists.
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    const bottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    if (input.draft) {
      pdf.save();
      pdf.rotate(-35, { origin: [pdf.page.width / 2, pdf.page.height / 2] });
      pdf
        .font("bold")
        .fontSize(90)
        .fillColor("#cc0000")
        .fillOpacity(0.12)
        .text(w("draft"), 0, pdf.page.height / 2 - 50, { width: pdf.page.width, align: "center", lineBreak: false });
      pdf.restore();
      pdf.fillOpacity(1);
    }
    pdf
      .font("text")
      .fontSize(7)
      .fillColor(muted)
      .text(`${d.seller.name} · ${input.draft ? w("draft") : d.number} · ${w("page", { n: i + 1, of: range.count })}`, left, pdf.page.height - 35, {
        width,
        align: "center",
        lineBreak: false,
      });
    pdf.page.margins.bottom = bottom;
  }
  pdf.end();
  return done;
}
