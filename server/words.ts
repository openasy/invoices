// The amount in words, which Turkish invoices carry under the total ("Yalnız ..."): 230400,50 TL is "Yalnız iki yüz
// otuz bin dört yüz Türk lirası elli kuruş". Turkish says "yüz" and "bin", never "bir yüz" or "bir bin".

const ONES = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
const GROUPS = ["", "bin", "milyon", "milyar", "trilyon"];

function hundreds(n: number): string[] {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  return [h > 1 ? ONES[h]! : "", h > 0 ? "yüz" : "", TENS[t]!, ONES[o]!].filter(Boolean);
}

/** A whole number in Turkish words: 1001 is "bin bir"; 0 is "sıfır". */
export function turkishWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("A whole number of 0 or more.");
  if (n === 0) return "sıfır";
  const words: string[] = [];
  let g = 0;
  const parts: string[][] = [];
  while (n > 0) {
    const chunk = n % 1000;
    if (chunk) parts.unshift([...(g === 1 && chunk === 1 ? [] : hundreds(chunk)), GROUPS[g]!].filter(Boolean));
    n = Math.floor(n / 1000);
    g++;
  }
  for (const p of parts) words.push(...p);
  return words.join(" ");
}

const NAMES: Record<string, [string, string]> = {
  TRY: ["Türk lirası", "kuruş"],
  USD: ["ABD doları", "sent"],
  EUR: ["avro", "sent"],
  GBP: ["İngiliz sterlini", "peni"],
  CHF: ["İsviçre frangı", "santim"],
};

/** "Yalnız ... Türk lirası ... kuruş" for an amount in minor units. */
export function amountInWords(minor: number, currency: string): string {
  const [major, sub] = NAMES[currency] ?? [currency, `${currency} kuruşu`];
  const whole = Math.floor(Math.abs(minor) / 100);
  const cents = Math.abs(minor) % 100;
  return `Yalnız ${minor < 0 ? "eksi " : ""}${turkishWords(whole)} ${major}${cents ? ` ${turkishWords(cents)} ${sub}` : ""}`;
}
