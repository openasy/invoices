import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bulletinXml, startFakes, type Fakes } from "./fakes.ts";
import { parseBulletin, rateFor, rateOf, tcmb } from "./tcmb.ts";

let fakes: Fakes;
beforeAll(async () => {
  fakes = await startFakes();
});
afterAll(() => fakes.close());

function memoryCache() {
  const rates = new Map<string, number>();
  const missing = new Set<string>();
  return {
    get: (d: string, c: string, k: string) => rates.get(`${d}|${c}|${k}`),
    put: (b: ReturnType<typeof parseBulletin>) => {
      for (const [c, kinds] of b.rates) for (const [k, r] of Object.entries(kinds)) rates.set(`${b.date}|${c}|${k}`, r);
    },
    missing: (d: string) => missing.has(d),
    markMissing: (d: string) => void missing.add(d),
  };
}

describe("TCMB rates", () => {
  it("reads a bulletin, with JPY's rate per 100 brought to one yen", () => {
    const b = parseBulletin(
      bulletinXml("2026-10-30", { USD: { buying: "34.2512", selling: "34.3129" }, JPY: { unit: 100, buying: "22.4180", selling: "22.5664" } }),
    );
    expect(b.date).toBe("2026-10-30");
    expect(b.rates.get("USD")).toEqual({ forex_buying: 342512, forex_selling: 343129, banknote_buying: 342512, banknote_selling: 343129 });
    expect(b.rates.get("JPY")?.forex_buying).toBe(2242);
    expect(rateOf("1", 1)).toBe(10000);
    expect(rateOf("x", 1)).toBeNull();
  });

  it("takes the last bulletin before the invoice's day: Monday's invoice has Friday's rate", async () => {
    fakes.tcmb.bulletins.set("2026-10-30", bulletinXml("2026-10-30", { USD: { buying: "34.2512", selling: "34.3129" } }));
    const source = tcmb({ url: `${fakes.base}/tcmb` });
    const cache = memoryCache();
    expect(await rateFor(source, cache, "2026-11-02", "USD", "forex_buying")).toEqual({ rate: 342512, date: "2026-10-30" });
    // Sunday and Saturday were asked for and had none; Friday's was found. Asked again, nothing is fetched.
    expect(fakes.tcmb.requests).toEqual(["/tcmb/202611/01112026.xml", "/tcmb/202610/31102026.xml", "/tcmb/202610/30102026.xml"]);
    await rateFor(source, cache, "2026-11-02", "USD", "forex_buying");
    expect(fakes.tcmb.requests).toHaveLength(3);
    await expect(rateFor(source, cache, "2026-11-02", "CHF", "forex_buying")).rejects.toThrow(/no forex_buying rate for CHF/);
    await expect(rateFor(source, memoryCache(), "2026-06-01", "USD", "forex_buying")).rejects.toThrow(/ten days/);
  });
});
