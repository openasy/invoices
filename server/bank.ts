// Bank statements, read from the files banks give: CSV (or Excel saved as CSV) with the columns the file names, or
// MT940, which Turkish banks give corporate customers. Each line is a day, an amount in minor units (money in above
// 0, money out below), a description and the bank's reference. Matching lines to invoices is in invoices.ts.
import { createHash } from "node:crypto";
import type { BankAccount } from "./config.ts";
import { isDay } from "./store.ts";

export interface StatementLine {
  date: string;
  amount: number;
  description: string;
  reference: string | null;
}

export class StatementError extends Error {}

/** Splits CSV text into rows, with quoted fields and "" inside them. */
export function csvRows(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === separator) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** "1.234,56", "-1234.56", "1.234,56 TL" or "+1,234.56" as minor units. */
export function parseAmount(raw: string, decimal: "," | "."): number | null {
  let s = raw.replace(/\s|TL|TRY|EUR|USD|₺/g, "");
  if (!s) return null;
  const negative = s.startsWith("-") || (s.startsWith("(") && s.endsWith(")"));
  s = s.replace(/^[-+(]|\)$/g, "");
  s = decimal === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const v = Number(w) * 100 + Number(f.padEnd(2, "0"));
  return negative ? -v : v;
}

function parseDate(raw: string, format: BankAccount["csv"]["dateFormat"]): string | null {
  const s = raw.trim().slice(0, 10);
  let d: string | null = null;
  if (format === "YYYY-MM-DD") d = s;
  else {
    const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
    if (m) d = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return d && isDay(d) ? d : null;
}

const norm = (s: string) => s.trim().toLocaleLowerCase("tr");

export function parseCsvStatement(text: string, account: BankAccount): StatementLine[] {
  const c = account.csv;
  const rows = csvRows(text, c.separator);
  // The header is the first row that names the date column; banks often put the account's details above it.
  const at = rows.findIndex((r) => r.some((x) => norm(x) === norm(c.date)));
  if (at < 0) throw new StatementError(`No header row with the column ${c.date}.`);
  const header = rows[at]!.map(norm);
  const col = (name: string | null) => (name === null ? -1 : header.indexOf(norm(name)));
  const need = (name: string | null) => {
    const i = col(name);
    if (name !== null && i < 0) throw new StatementError(`The header has no column ${name}; it has ${rows[at]!.join(", ")}.`);
    return i;
  };
  const iDate = need(c.date);
  const iAmount = need(c.amount);
  const iCredit = need(c.credit);
  const iDebit = need(c.debit);
  const iDesc = need(c.description);
  const iRef = need(c.reference);
  const out: StatementLine[] = [];
  rows.slice(at + 1).forEach((r, n) => {
    const date = parseDate(r[iDate] ?? "", c.dateFormat);
    // Lines without a day are the bank's totals and balances.
    if (!date) return;
    let amount: number | null;
    if (iAmount >= 0) amount = parseAmount(r[iAmount] ?? "", c.decimal);
    else {
      const credit = parseAmount(r[iCredit] ?? "", c.decimal) ?? 0;
      const debit = iDebit >= 0 ? (parseAmount(r[iDebit] ?? "", c.decimal) ?? 0) : 0;
      amount = Math.abs(credit) - Math.abs(debit);
    }
    if (amount === null) throw new StatementError(`Row ${at + n + 2}: the amount ${r[iAmount] ?? ""} cannot be read.`);
    out.push({ date, amount, description: (r[iDesc] ?? "").trim(), reference: iRef >= 0 ? (r[iRef] ?? "").trim() || null : null });
  });
  return out;
}

/** MT940: each :61: statement line, with the :86: text that follows it. */
export function parseMt940(text: string): StatementLine[] {
  const out: StatementLine[] = [];
  const tags = text.replace(/\r\n?/g, "\n").split(/\n(?=:\d{2}[A-Z]?:)/);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]!.replace(/^\n+/, "");
    if (!t.startsWith(":61:")) continue;
    const m = /^:61:(\d{2})(\d{2})(\d{2})(?:\d{4})?(R?[CD])[A-Z]?(\d+(?:,\d{0,2})?)([A-Z]\w{3})?([^\n/]*)(?:\/\/([^\n]*))?/.exec(t);
    if (!m) throw new StatementError(`An MT940 :61: line cannot be read: ${t.split("\n")[0]}`);
    const date = `20${m[1]}-${m[2]}-${m[3]}`;
    const [w, f = ""] = m[5]!.split(",");
    let amount = Number(w) * 100 + Number(f.padEnd(2, "0"));
    const mark = m[4]!;
    if (mark === "D" || mark === "RC") amount = -amount;
    const next = tags[i + 1];
    const description = next?.startsWith(":86:") ? next.slice(4).replace(/\n/g, " ").trim() : t.split("\n").slice(1).join(" ").trim();
    const reference = (m[8] ?? m[7] ?? "").trim() || null;
    if (!isDay(date)) throw new StatementError(`An MT940 line has the day ${date}, which does not exist.`);
    out.push({ date, amount, description, reference: reference === "NONREF" ? null : reference });
  }
  return out;
}

export function parseStatement(text: string, account: BankAccount): StatementLine[] {
  return account.format === "mt940" ? parseMt940(text) : parseCsvStatement(text, account);
}

/** What makes a line the same line when a statement is imported again. */
export function fingerprint(l: StatementLine, n: number): string {
  return createHash("sha256")
    .update(JSON.stringify([l.date, l.amount, l.reference, l.description, n]))
    .digest("hex")
    .slice(0, 32);
}
