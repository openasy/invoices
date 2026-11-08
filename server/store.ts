// What the parts of Invoices share: the error the API turns into a problem, who does something, the database helpers
// and the checks that read a request's fields.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Role } from "@openasy/auth";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "not-linked"
  | "link-failed"
  | "rate-limited"
  | "payload-too-large"
  | "internal-error";

export class AppError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Who does something: a signed-in member, an API token, the tests' admin token, or Invoices itself. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export const SYSTEM: Actor = { id: "system", name: "Invoices", role: "admin" };

export const bad = (message: string) => new AppError(422, "invalid-body", message);
export const notFound = (what: string) => new AppError(404, "not-found", `${what} does not exist.`);
export const conflict = (message: string) => new AppError(409, "conflict", message);
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const DAY = 86_400_000;
export const MINUTE = 60_000;

export function createStore(db: DatabaseSync, clock: () => number) {
  let depth = 0;
  return {
    db,
    clock,
    iso: (ms = clock()) => new Date(ms).toISOString(),
    q: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[],
    one: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined,
    run: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args),
    /**
     * Runs fn in one write transaction. BEGIN IMMEDIATE takes the write lock at once, so a check and the write that
     * follows it (the next invoice number, above all) cannot be split by another writer.
     */
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}
export type Store = ReturnType<typeof createStore>;

/** The body as a map, or a 422 that says what it takes. */
export function body(v: unknown, takes: string[]): Record<string, unknown> {
  if (!isObj(v)) throw bad(`The body is a JSON object with ${takes.join(", ")}.`);
  const extra = Object.keys(v).filter((k) => !takes.includes(k));
  if (extra.length) throw bad(`unknown ${extra.join(", ")}; it takes ${takes.join(", ")}.`);
  return v;
}

/** A required text field. */
export function text(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw bad(`${field} is a text of 1 to ${max} characters.`);
  return v.trim();
}

/** A text field that may be left out (undefined), cleared (null or ""), or set. */
export function optText(v: unknown, field: string, max = 200): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  return text(v, field, max);
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export function optEmail(v: unknown, field = "email"): string | null | undefined {
  const s = optText(v, field, 254);
  if (s === undefined || s === null) return s;
  if (!EMAIL.test(s)) throw bad(`${field} is an email address.`);
  return s.toLowerCase();
}

export function isDay(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
    new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)
  );
}

export function day(v: unknown, field: string): string {
  if (!isDay(v)) throw bad(`${field} is a day, YYYY-MM-DD.`);
  return v;
}

export function optDay(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return day(v, field);
}

/** An amount in minor units (kuruş for TRY): a whole number, 0 or more. 4500050 is 45.000,50 TL. */
export function minor(v: unknown, field: string, { negative = false } = {}): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || (!negative && v < 0) || Math.abs(v) > 1e15)
    throw bad(`${field} is a whole number of minor units (kuruş for TRY), such as 4500050 for 45.000,50 TL.`);
  return v;
}

/** A quantity with at most three decimals, as thousandths: 1.5 is 1500. */
export function quantity(v: unknown, field: string): number {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1e9 || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-6)
    throw bad(`${field} is a quantity above 0 with at most three decimals.`);
  return Math.round(n * 1000);
}

export function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${field} is a whole number from ${min} to ${max}.`);
  return v;
}

/** Days are compared and moved as YYYY-MM-DD in UTC, so a day never shifts with the server's zone. */
export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/** The day it is at `ms` in the time zone, YYYY-MM-DD. */
export function dayIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Minutes since midnight at `ms` in the time zone. */
export function minuteIn(ms: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
}
