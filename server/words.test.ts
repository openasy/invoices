import { describe, expect, it } from "vitest";
import { amountInWords, turkishWords } from "./words.ts";

describe("the amount in words", () => {
  it("writes Turkish numbers as an invoice does", () => {
    expect(turkishWords(0)).toBe("sıfır");
    expect(turkishWords(1)).toBe("bir");
    expect(turkishWords(100)).toBe("yüz");
    expect(turkishWords(1000)).toBe("bin");
    expect(turkishWords(1001)).toBe("bin bir");
    expect(turkishWords(2100)).toBe("iki bin yüz");
    expect(turkishWords(230400)).toBe("iki yüz otuz bin dört yüz");
    expect(turkishWords(1_000_000)).toBe("bir milyon");
    expect(turkishWords(1_001_000)).toBe("bir milyon bin");
    expect(turkishWords(98_765_432)).toBe("doksan sekiz milyon yedi yüz altmış beş bin dört yüz otuz iki");
  });

  it("names the currency and its kuruş", () => {
    expect(amountInWords(23040050, "TRY")).toBe("Yalnız iki yüz otuz bin dört yüz Türk lirası elli kuruş");
    expect(amountInWords(100000, "TRY")).toBe("Yalnız bin Türk lirası");
    expect(amountInWords(1250, "EUR")).toBe("Yalnız on iki avro elli sent");
  });
});
