// What the pages share: data loading with the session, formatting money and days, the state an invoice is shown in,
// and the totals as the server calculated them.
import { useAuth } from "@openasy/auth/react";
import { StatusBadge, type Tone } from "@openasy/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Status, type Totals } from "./api.ts";
import type { T } from "./i18n.ts";
import { viewerLocale } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1)] as const;
}

export const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });
export const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "danger" ? "bg-danger-soft" : "bg-success-soft"}`}
    >
      {children}
    </div>
  );
}

export type Note = { text: string; tone?: "danger" } | null;

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="inv-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

// ---------------------------------------------------------------- formatting

/** 4500050 kuruş is "45,000.50 TL" in English and "45.000,50 TL" in Turkish; TRY is written TL, as people write it. */
export function money(minor: number, currency = "TRY", locale: string = viewerLocale()) {
  const v = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
  return `${v} ${currency === "TRY" ? "TL" : currency}`;
}

/** An amount as typed in a field: "2400", "2.400,50", "2,400.50" or "2400.5"; null when it is not one. */
export function parseMoney(raw: string): number | null {
  let s = raw.replace(/\s|TL|TRY|₺/gi, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const dec = lastComma > lastDot ? (/,\d{1,2}$/.test(s) ? "," : null) : lastDot > lastComma ? (/\.\d{1,2}$/.test(s) ? "." : null) : null;
  s = dec === "," ? s.replace(/\./g, "").replace(",", ".") : dec === "." ? s.replace(/,/g, "") : s.replace(/[.,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
}

/** Minor units as a field shows them to be changed: 240000 is "2400", 240050 is "2400.50" or "2400,50". */
export function moneyInput(minor: number, locale: string = viewerLocale()) {
  const whole = Math.trunc(minor / 100);
  const cents = Math.abs(minor % 100);
  if (!cents) return String(whole);
  const sep = new Intl.NumberFormat(locale).format(1.5).includes(",") ? "," : ".";
  return `${whole}${sep}${String(cents).padStart(2, "0")}`;
}

/** A quantity as typed: "1,5" or "1.5"; null when it is not a number above 0. */
export function parseQty(raw: string): number | null {
  const n = Number(raw.trim().replace(",", "."));
  return raw.trim() && Number.isFinite(n) && n > 0 ? n : null;
}

export const qty = (n: number, locale: string = viewerLocale()) => new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(n);
export const num = (n: number, locale: string = viewerLocale()) => new Intl.NumberFormat(locale).format(n);

export const day = (d: string, locale: string = viewerLocale()) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const shortDay = (d: string, locale: string = viewerLocale()) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
export const monthName = (m: string, locale: string = viewerLocale(), long = false) =>
  new Date(`${m}-15T12:00:00Z`).toLocaleDateString(locale, { month: long ? "long" : "short", ...(long && { year: "numeric" }), timeZone: "UTC" });
export const when = (iso: string, locale: string = viewerLocale()) =>
  new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Today as YYYY-MM-DD in the browser's zone. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Reads a file the person picked as text. */
export const readFile = (f: File) => f.text();

// ---------------------------------------------------------------- invoices

export const STATUS_TONE: Record<Status, Tone> = {
  draft: "neutral",
  queued: "info",
  waiting: "info",
  delivered: "success",
  accepted: "success",
  rejected: "danger",
  refused: "danger",
  failed: "danger",
  cancelled: "neutral",
};

export function StateBadge({ status, t }: { status: Status; t: T }) {
  return <StatusBadge tone={STATUS_TONE[status]}>{t(`status.${status}`)}</StatusBadge>;
}

export const channelName = (c: string | null) => (c === "e-fatura" ? "e-Fatura" : c === "e-arsiv" ? "e-Arşiv" : "");

/** The totals of an invoice or a draft, exactly as the server calculated them. */
export function TotalsList({
  totals,
  currency,
  rate,
  tryPayable,
  home,
  t,
  locale,
  pending,
}: {
  totals: Totals;
  currency: string;
  rate?: string | null;
  tryPayable?: number | null;
  home: string;
  t: T;
  locale?: string;
  pending?: boolean;
}) {
  const m = (n: number, c = currency) => money(n, c, locale);
  const rates = totals.kdvBreakdown.map((k) => `${k.rate}%`);
  return (
    <section aria-label={t("totals.label")} aria-busy={pending || undefined} className={`ml-auto w-full max-w-sm px-3 py-2 ${pending ? "opacity-60" : ""}`}>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
        {totals.discount > 0 && (
          <>
            <dt className="text-fg-muted">{t("totals.discount")}</dt>
            <dd className="text-end font-mono">−{m(totals.discount)}</dd>
          </>
        )}
        <dt className="text-fg-muted">{t("totals.net")}</dt>
        <dd className="text-end font-mono">{m(totals.net)}</dd>
        <dt className="text-fg-muted">{t("totals.kdv", { rates: [...new Set(rates)].join(", ") || "0%" })}</dt>
        <dd className="text-end font-mono">{m(totals.kdv)}</dd>
        {totals.withholdingBreakdown.map((w) => (
          <div key={w.code} className="contents">
            <dt className="text-fg-muted">{t("totals.withheld", { code: w.code, share: w.share })}</dt>
            <dd className="text-end font-mono">−{m(w.amount)}</dd>
          </div>
        ))}
        <dt className="font-semibold">{t("totals.payable")}</dt>
        <dd className="text-end font-mono font-semibold">{m(totals.payable)}</dd>
        {rate && tryPayable !== undefined && tryPayable !== null && (
          <>
            <dt className="text-fg-muted">{t("totals.inHome", { rate })}</dt>
            <dd className="text-end font-mono">{m(tryPayable, home)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** A file input styled as a button. */
export function FileButton({
  label,
  accept,
  onFile,
  icon,
  disabled,
}: {
  label: string;
  accept: string;
  onFile: (f: File) => void;
  icon: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-sm font-medium text-fg hover:bg-subtle focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <span aria-hidden className="inv-icon">
        {icon}
      </span>
      {label}
      <input
        type="file"
        accept={accept}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}
