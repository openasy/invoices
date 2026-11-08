// Exchange rates from the Central Bank of the Republic of Türkiye (TCMB). Each working day at 15:30 TCMB publishes
// its indicative rates at /kurlar/today.xml and keeps them at /kurlar/YYYYMM/DDMMYYYY.xml; they are the rates of the
// next day. An invoice in a foreign currency takes the rate of the last bulletin published before its date: for an
// invoice of Monday 9 November, Friday 6 November's. A rate is kept in ten-thousandths of a lira, as TCMB writes it
// with four decimals; a rate given per 100 units (JPY) is divided down to one unit.
import type { RateKind } from "./config.ts";
import { addDays } from "./store.ts";
import { first, kids, parseXml, textAt } from "./xml.ts";

export class RateError extends Error {}

const FIELDS: Record<RateKind, string> = {
  forex_buying: "ForexBuying",
  forex_selling: "ForexSelling",
  banknote_buying: "BanknoteBuying",
  banknote_selling: "BanknoteSelling",
};

export interface Bulletin {
  /** YYYY-MM-DD, the day it was published. */
  date: string;
  /** Currency code to rate kind to ten-thousandths of a lira per unit. */
  rates: Map<string, Partial<Record<RateKind, number>>>;
}

/** "32.4567" per unit 1 is 324567; "21.5432" per unit 100 is 2154. */
export function rateOf(value: string | null, unit: number): number | null {
  if (!value || !/^\d+(\.\d{1,6})?$/.test(value.trim())) return null;
  const [w, f = ""] = value.trim().split(".");
  const tenThousandths = Number(w) * 10000 + Number(f.padEnd(6, "0").slice(0, 6)) / 100;
  const r = Math.round(tenThousandths / unit);
  return r > 0 ? r : null;
}

export function parseBulletin(xml: string): Bulletin {
  const root = parseXml(xml);
  const tarih = root.attrs.Tarih ?? "";
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(tarih);
  if (root.name !== "Tarih_Date" || !m) throw new RateError("Not a TCMB bulletin: no Tarih_Date with Tarih.");
  const rates = new Map<string, Partial<Record<RateKind, number>>>();
  for (const c of kids(root, "Currency")) {
    const code = c.attrs.CurrencyCode ?? c.attrs.Kod;
    const unit = Number(textAt(c, "Unit") ?? "1") || 1;
    if (!code || !first(c, "Unit")) continue;
    const r: Partial<Record<RateKind, number>> = {};
    for (const [kind, field] of Object.entries(FIELDS) as Array<[RateKind, string]>) {
      const v = rateOf(textAt(c, field), unit);
      if (v !== null) r[kind] = v;
    }
    rates.set(code, r);
  }
  return { date: `${m[3]}-${m[2]}-${m[1]}`, rates };
}

export interface RateSource {
  /** The bulletin published on this day, or null when there was none (a weekend or a holiday). */
  bulletin(day: string): Promise<Bulletin | null>;
}

export function tcmb(o: { url: string; fetch?: typeof fetch }): RateSource {
  const f = o.fetch ?? fetch;
  return {
    async bulletin(day) {
      const [y, mo, d] = day.split("-");
      let res: Response;
      try {
        res = await f(`${o.url}/${y}${mo}/${d}${mo}${y}.xml`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      } catch (err) {
        throw new RateError(`TCMB could not be reached: ${(err as Error).message}`);
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new RateError(`TCMB answered ${res.status}.`);
      return parseBulletin(await res.text());
    },
  };
}

/** The bulletin an invoice of `day` uses: the last one published before it, looking back up to ten days. */
export async function rateFor(
  source: RateSource,
  cache: {
    get(day: string, currency: string, kind: RateKind): number | undefined;
    put(b: Bulletin): void;
    missing(day: string): boolean;
    markMissing(day: string): void;
  },
  day: string,
  currency: string,
  kind: RateKind,
): Promise<{ rate: number; date: string }> {
  for (let back = 1; back <= 10; back++) {
    const d = addDays(day, -back);
    const known = cache.get(d, currency, kind);
    if (known !== undefined) return { rate: known, date: d };
    if (cache.missing(d)) continue;
    const b = await source.bulletin(d);
    if (!b) {
      cache.markMissing(d);
      continue;
    }
    cache.put(b);
    const r = b.rates.get(currency)?.[kind];
    if (r === undefined) throw new RateError(`TCMB's bulletin of ${d} has no ${kind} rate for ${currency}.`);
    return { rate: r, date: d };
  }
  throw new RateError(`No TCMB bulletin in the ten days before ${day}.`);
}
