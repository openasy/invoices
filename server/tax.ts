// KDV, its withholding (tevkifat) and exemptions, and how a line and an invoice are added up. Every amount is a whole
// number of minor units (kuruş for TRY) in the invoice's currency; quantities are thousandths. Each line is rounded
// once, half up, and the invoice's totals are sums of its lines, so the totals and the UBL-TR file always agree.
import { bad } from "./store.ts";

/** A withholding code with the share of the KDV the buyer withholds and pays to the tax office, as a fraction. */
export interface Withholding {
  code: string;
  name: string;
  /** Tenths: 2 is 2/10, 9 is 9/10. */
  tenths: number;
}

/**
 * The partial withholding codes of GİB's e-Fatura code list (KDV Genel Uygulama Tebliği I/C-2.1.3) with their shares.
 * Shares change by communiqué: check them with your accountant, and set a code in the file (`withholding`) to change
 * its share or add one.
 */
export const WITHHOLDING: Withholding[] = [
  { code: "601", name: "Yapım işleri ile bu işlerle birlikte ifa edilen mühendislik-mimarlık ve etüt-proje hizmetleri", tenths: 4 },
  { code: "602", name: "Etüt, plan-proje, danışmanlık, denetim ve benzeri hizmetler", tenths: 9 },
  { code: "603", name: "Makine, teçhizat, demirbaş ve taşıtlara ait tadil, bakım ve onarım hizmetleri", tenths: 7 },
  { code: "604", name: "Yemek servis hizmeti", tenths: 5 },
  { code: "605", name: "Organizasyon hizmeti", tenths: 5 },
  { code: "606", name: "İşgücü temin hizmetleri", tenths: 9 },
  { code: "607", name: "Özel güvenlik hizmeti", tenths: 9 },
  { code: "608", name: "Yapı denetim hizmetleri", tenths: 9 },
  { code: "609", name: "Fason olarak yaptırılan tekstil ve konfeksiyon işleri, çanta ve ayakkabı dikim işleri", tenths: 7 },
  { code: "610", name: "Turistik mağazalara verilen müşteri bulma / götürme hizmetleri", tenths: 9 },
  { code: "611", name: "Spor kulüplerinin yayın, reklam ve isim hakkı gelirlerine konu işlemleri", tenths: 9 },
  { code: "612", name: "Temizlik, çevre ve bahçe bakım hizmetleri", tenths: 9 },
  { code: "613", name: "Servis taşımacılığı hizmeti", tenths: 5 },
  { code: "614", name: "Her türlü baskı ve basım hizmetleri", tenths: 7 },
  { code: "624", name: "Yük taşımacılığı hizmeti", tenths: 2 },
  { code: "625", name: "Ticari reklam hizmetleri", tenths: 3 },
  { code: "626", name: "Diğer teslimler", tenths: 2 },
  { code: "627", name: "Demir-çelik ürünlerinin teslimi", tenths: 5 },
];

/** A KDV exemption reason (TaxExemptionReasonCode), needed on every line with 0% KDV. */
export interface Exemption {
  code: string;
  name: string;
  /** false for 351, which says the 0% is not an exemption: the invoice stays SATIS. */
  exempt: boolean;
}

/** The exemption codes most invoices need; add others from GİB's code list in the file (`exemptions`). */
export const EXEMPTIONS: Exemption[] = [
  { code: "301", name: "11/1-a Mal ihracatı", exempt: true },
  { code: "302", name: "11/1-a Hizmet ihracatı", exempt: true },
  { code: "351", name: "KDV - İstisna olmayan diğer", exempt: false },
];

/** The KDV rates in force since 10 July 2023 (Cumhurbaşkanı Kararı 7346); the file may narrow or change the list. */
export const KDV_RATES = [0, 1, 10, 20];

/** a × b / c, rounded half up, for non-negative whole numbers of any size. */
export function mulDiv(a: number, b: number, c: number): number {
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  const r = (n * 2n + d) / (d * 2n);
  return Number(r);
}

export interface LineInput {
  /** Thousandths. */
  quantity: number;
  /** Minor units, without KDV. */
  unitPrice: number;
  /** Hundredths of a percent: 1000 is 10%. */
  discount: number;
  /** Percent. */
  kdvRate: number;
  withholding: string | null;
  /** The withholding's share in tenths, fixed on the line when it is written so a later file does not change it. */
  withholdingTenths: number;
  exemption: string | null;
}

export interface LineTotals {
  gross: number;
  discountAmount: number;
  /** Without KDV, after the discount: UBL-TR's LineExtensionAmount. */
  net: number;
  kdv: number;
  withheld: number;
}

export interface TaxTables {
  kdvRates: number[];
  withholding: Map<string, Withholding>;
  exemptions: Map<string, Exemption>;
}

export const DEFAULT_TABLES: TaxTables = {
  kdvRates: KDV_RATES,
  withholding: new Map(WITHHOLDING.map((w) => [w.code, w])),
  exemptions: new Map(EXEMPTIONS.map((e) => [e.code, e])),
};

/** Checks a line's taxes against the tables, so a line that cannot be invoiced is refused when it is written. */
export function checkLineTax(l: Pick<LineInput, "kdvRate" | "withholding" | "exemption">, t: TaxTables, at: string) {
  if (!t.kdvRates.includes(l.kdvRate)) throw bad(`${at}.kdvRate is one of ${t.kdvRates.join(", ")}.`);
  if (l.kdvRate === 0 && !l.exemption)
    throw bad(`${at}: a line with 0% KDV needs an exemption code (TaxExemptionReasonCode), one of ${[...t.exemptions.keys()].join(", ")}.`);
  if (l.kdvRate !== 0 && l.exemption) throw bad(`${at}: an exemption code is only for a line with 0% KDV.`);
  if (l.exemption && !t.exemptions.has(l.exemption)) throw bad(`${at}.exemption is one of ${[...t.exemptions.keys()].join(", ")}.`);
  if (l.withholding && !t.withholding.has(l.withholding)) throw bad(`${at}.withholding is a code in the file's list, such as 602 or 624.`);
  if (l.withholding && l.kdvRate === 0) throw bad(`${at}: withholding is a share of the KDV, so a line with 0% KDV has none.`);
}

export function lineTotals(l: LineInput): LineTotals {
  const gross = mulDiv(l.quantity, l.unitPrice, 1000);
  const discountAmount = mulDiv(gross, l.discount, 10000);
  const net = gross - discountAmount;
  const kdv = mulDiv(net, l.kdvRate, 100);
  const withheld = l.withholding ? mulDiv(kdv, l.withholdingTenths, 10) : 0;
  return { gross, discountAmount, net, kdv, withheld };
}

export type InvoiceTypeCode = "SATIS" | "TEVKIFAT" | "ISTISNA" | "IADE";

export interface Totals {
  /** Sum of the lines' gross amounts, before discounts. */
  gross: number;
  discount: number;
  /** Without KDV: TaxExclusiveAmount. */
  net: number;
  kdv: number;
  withheld: number;
  /** With KDV: TaxInclusiveAmount. */
  total: number;
  /** What the buyer pays: the total less the withheld KDV. PayableAmount. */
  payable: number;
  /** KDV by rate and exemption, as the UBL-TR TaxSubtotals and the PDF show it. */
  kdvBreakdown: Array<{ rate: number; exemption: string | null; base: number; amount: number }>;
  withholdingBreakdown: Array<{ code: string; tenths: number; base: number; amount: number }>;
}

export function invoiceTotals(lines: LineInput[]): Totals & { lines: LineTotals[] } {
  const each = lines.map((l) => lineTotals(l));
  const sum = (k: keyof LineTotals) => each.reduce((s, x) => s + x[k], 0);
  const kdv = new Map<string, Totals["kdvBreakdown"][number]>();
  const wh = new Map<string, Totals["withholdingBreakdown"][number]>();
  lines.forEach((l, i) => {
    const x = each[i]!;
    const key = `${l.kdvRate}|${l.exemption ?? ""}`;
    const k = kdv.get(key) ?? { rate: l.kdvRate, exemption: l.exemption, base: 0, amount: 0 };
    k.base += x.net;
    k.amount += x.kdv;
    kdv.set(key, k);
    if (l.withholding) {
      const w = wh.get(l.withholding) ?? { code: l.withholding, tenths: l.withholdingTenths, base: 0, amount: 0 };
      w.base += x.kdv;
      w.amount += x.withheld;
      wh.set(l.withholding, w);
    }
  });
  const net = sum("net");
  const total = net + sum("kdv");
  return {
    lines: each,
    gross: sum("gross"),
    discount: sum("discountAmount"),
    net,
    kdv: sum("kdv"),
    withheld: sum("withheld"),
    total,
    payable: total - sum("withheld"),
    kdvBreakdown: [...kdv.values()].sort((a, b) => b.rate - a.rate || (a.exemption ?? "").localeCompare(b.exemption ?? "")),
    withholdingBreakdown: [...wh.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

/** The InvoiceTypeCode GİB expects for these lines. */
export function typeCode(lines: LineInput[], creditNote: boolean, t: TaxTables = DEFAULT_TABLES): InvoiceTypeCode {
  if (creditNote) return "IADE";
  const withholding = lines.some((l) => l.withholding);
  const exempt = lines.some((l) => l.exemption && t.exemptions.get(l.exemption)?.exempt);
  if (withholding && exempt) throw bad("An invoice with withholding cannot also have exempt lines; make two invoices.");
  if (withholding) return "TEVKIFAT";
  if (exempt) {
    if (!lines.every((l) => l.kdvRate === 0)) throw bad("An exempt invoice (ISTISNA) has 0% KDV on every line; put the other lines on another invoice.");
    return "ISTISNA";
  }
  return "SATIS";
}

/** A Turkish identity number (TCKN): 11 digits with its two check digits. 11111111111 is GİB's number for a buyer who gives none. */
export function validTckn(v: string): boolean {
  if (v === "11111111111") return true;
  if (!/^[1-9]\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((s, x) => s + x, 0) % 10 === d[10];
}

/** A tax number (VKN) is 10 digits; a person's is their TCKN. */
export function taxIdKind(v: string): "vkn" | "tckn" | null {
  if (/^\d{10}$/.test(v)) return "vkn";
  if (validTckn(v)) return "tckn";
  return null;
}

/** Converts minor units of a currency to kuruş at a rate kept in ten-thousandths (TCMB's four decimals). */
export const toTry = (amount: number, rate: number | null) => (rate === null ? amount : mulDiv(amount, rate, 10000));
