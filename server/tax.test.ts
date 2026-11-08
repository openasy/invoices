import { describe, expect, it } from "vitest";
import { DEFAULT_TABLES, invoiceTotals, lineTotals, mulDiv, taxIdKind, typeCode, validTckn, type LineInput } from "./tax.ts";

const line = (o: Partial<LineInput>): LineInput => ({
  quantity: 1000,
  unitPrice: 10000,
  discount: 0,
  kdvRate: 20,
  withholding: null,
  withholdingTenths: 0,
  exemption: null,
  ...o,
});

describe("KDV, withholding and the sums", () => {
  it("rounds each line once, half up, and adds the lines", () => {
    expect(mulDiv(5, 1, 10)).toBe(1); // 0.5 rounds up
    expect(mulDiv(4, 1, 10)).toBe(0);
    // 3 × 33,33 TL with 10% off: 99,99 - 10,00 (9,999 rounds to 10,00) = 89,99; KDV 20% is 18,00 (17,998).
    const l = lineTotals(line({ quantity: 3000, unitPrice: 3333, discount: 1000 }));
    expect(l).toEqual({ gross: 9999, discountAmount: 1000, net: 8999, kdv: 1800, withheld: 0 });
    // 1,5 hours at 1.250,00 TL is 1.875,00 TL.
    expect(lineTotals(line({ quantity: 1500, unitPrice: 125000 })).net).toBe(187500);
  });

  it("withholds the share of the KDV the code sets: 9/10 of 20% on 10.000 TL", () => {
    const t = invoiceTotals([line({ unitPrice: 1000000, withholding: "602", withholdingTenths: 9 })]);
    expect(t).toMatchObject({ net: 1000000, kdv: 200000, withheld: 180000, total: 1200000, payable: 1020000 });
    expect(t.withholdingBreakdown).toEqual([{ code: "602", tenths: 9, base: 200000, amount: 180000 }]);
  });

  it("breaks KDV down by rate and exemption, highest rate first", () => {
    const t = invoiceTotals([
      line({ unitPrice: 10000, kdvRate: 10 }),
      line({ unitPrice: 20000, kdvRate: 20 }),
      line({ unitPrice: 5000, kdvRate: 20 }),
      line({ unitPrice: 7000, kdvRate: 0, exemption: "351" }),
    ]);
    expect(t.kdvBreakdown).toEqual([
      { rate: 20, exemption: null, base: 25000, amount: 5000 },
      { rate: 10, exemption: null, base: 10000, amount: 1000 },
      { rate: 0, exemption: "351", base: 7000, amount: 0 },
    ]);
    expect(t.kdv).toBe(6000);
    expect(t.total).toBe(48000);
  });

  it("knows the invoice type GİB expects", () => {
    expect(typeCode([line({})], false)).toBe("SATIS");
    expect(typeCode([line({ withholding: "624", withholdingTenths: 2 })], false)).toBe("TEVKIFAT");
    expect(typeCode([line({ kdvRate: 0, exemption: "302" })], false)).toBe("ISTISNA");
    expect(typeCode([line({ kdvRate: 0, exemption: "351" })], false)).toBe("SATIS");
    expect(typeCode([line({})], true)).toBe("IADE");
    expect(() => typeCode([line({ kdvRate: 0, exemption: "302" }), line({})], false)).toThrow(/ISTISNA/);
    expect(() => typeCode([line({ kdvRate: 0, exemption: "302" }), line({ withholding: "624", withholdingTenths: 2 })], false)).toThrow(/withholding/);
    expect(DEFAULT_TABLES.withholding.get("624")?.tenths).toBe(2);
  });

  it("checks identity numbers", () => {
    expect(validTckn("10000000146")).toBe(true);
    expect(validTckn("10000000147")).toBe(false);
    expect(validTckn("11111111111")).toBe(true);
    expect(validTckn("01234567890")).toBe(false);
    expect(taxIdKind("1234567890")).toBe("vkn");
    expect(taxIdKind("10000000146")).toBe("tckn");
    expect(taxIdKind("12345")).toBeNull();
  });
});
