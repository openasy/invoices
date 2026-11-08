import { describe, expect, it } from "vitest";
import { csvRows, parseAmount, parseCsvStatement, parseMt940 } from "./bank.ts";
import { parseConfig } from "./config.ts";

const account = (csv: Record<string, string>) => parseConfig(`bank: { a: { csv: ${JSON.stringify(csv)} } }`).bank[0]!;

describe("bank statements", () => {
  it("reads amounts as Turkish and English banks write them", () => {
    expect(parseAmount("1.234,56", ",")).toBe(123456);
    expect(parseAmount("-1.234,5 TL", ",")).toBe(-123450);
    expect(parseAmount("+1,234.56", ".")).toBe(123456);
    expect(parseAmount("(10.00)", ".")).toBe(-1000);
    expect(parseAmount("abc", ",")).toBeNull();
    expect(csvRows('a;"b;c";"d ""e"""\r\n\r\n1;2;3', ";")).toEqual([
      ["a", "b;c", 'd "e"'],
      ["1", "2", "3"],
    ]);
  });

  it("reads a CSV statement below the bank's header lines, leaving out the balance rows", () => {
    const text = [
      "Hesap;TR33 0006 1005 1978 6457 8413 26",
      "",
      "Tarih;Açıklama;Tutar;Bakiye;Dekont No",
      "02.11.2026;HAVALE YILDIZ MIMARLIK ACM2026000000001;14.400,00;114.400,00;D-1",
      "03.11.2026;EFT ÖDEME KİRA;-25.000,00;89.400,00;D-2",
      ";Dönem sonu bakiyesi;;89.400,00;",
    ].join("\r\n");
    expect(parseCsvStatement(text, account({ reference: "Dekont No" }))).toEqual([
      { date: "2026-11-02", amount: 1440000, description: "HAVALE YILDIZ MIMARLIK ACM2026000000001", reference: "D-1" },
      { date: "2026-11-03", amount: -2500000, description: "EFT ÖDEME KİRA", reference: "D-2" },
    ]);
  });

  it("reads separate credit and debit columns", () => {
    const text = "Date,Details,Credit,Debit\n2026-11-02,Payment,100.00,\n2026-11-02,Fee,,2.50\n";
    const a = account({ date: "Date", description: "Details", credit: "Credit", debit: "Debit", separator: ",", date_format: "YYYY-MM-DD", decimal: "." });
    expect(parseCsvStatement(text, a).map((l) => l.amount)).toEqual([10000, -250]);
  });

  it("says which column is missing", () => {
    expect(() => parseCsvStatement("Tarih;Tutar\n02.11.2026;1,00", account({}))).toThrow(/Açıklama/);
  });

  it("reads MT940 lines and their :86: text", () => {
    const text = [
      ":20:STMT",
      ":25:TR330006100519786457841326",
      ":60F:C261101TRY100000,00",
      ":61:2611021102C14400,00NTRFNONREF//BNK-778",
      ":86:HAVALE YILDIZ MIMARLIK",
      "ACM2026000000001",
      ":61:261103D25000,NTRFKIRA",
      ":86:KIRA ODEMESI",
      ":62F:C261103TRY89400,00",
    ].join("\r\n");
    expect(parseMt940(text)).toEqual([
      { date: "2026-11-02", amount: 1440000, description: "HAVALE YILDIZ MIMARLIK ACM2026000000001", reference: "BNK-778" },
      { date: "2026-11-03", amount: -2500000, description: "KIRA ODEMESI", reference: "KIRA" },
    ]);
  });
});
