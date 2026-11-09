// Writing lines: the editor of a draft invoice, a credit note and a recurring invoice. The totals beside them come from
// the server's preview (POST /api/v1/invoices/preview), which rounds as issuing does; nothing is added up here.
import { IconButton, SelectField, TextField } from "@openasy/ui";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CatalogItem, Line, LineInput, Preview, Settings } from "./api.ts";
import { money, moneyInput, parseMoney, parseQty, type Call } from "./common.tsx";
import type { T } from "./i18n.ts";
import { viewerLocale } from "./i18n.ts";

export interface EditLine {
  key: string;
  product: string | null;
  code: string | null;
  name: string;
  description: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  discount: number;
  kdvRate: number;
  withholding: string | null;
  exemption: string | null;
}

let seq = 0;
export const lineKey = () => `l${++seq}`;

export function fromLine(l: Line | LineInput, locale: string = viewerLocale()): EditLine {
  const w = l.withholding;
  return {
    key: lineKey(),
    product: l.product ?? null,
    code: l.code ?? null,
    name: l.name ?? "",
    description: l.description ?? null,
    unit: l.unit ?? "C62",
    quantity: String(l.quantity ?? 1),
    unitPrice: moneyInput(l.unitPrice ?? 0, locale),
    discount: l.discount ?? 0,
    kdvRate: l.kdvRate ?? 20,
    withholding: typeof w === "object" && w ? w.code : (w ?? null),
    exemption: l.exemption ?? null,
  };
}

export function fromProduct(p: CatalogItem, locale: string = viewerLocale()): EditLine {
  return {
    key: lineKey(),
    product: p.id,
    code: p.code,
    name: p.name,
    description: null,
    unit: p.unit,
    quantity: "1",
    unitPrice: moneyInput(p.unitPrice, locale),
    discount: 0,
    kdvRate: p.kdvRate,
    withholding: p.withholding,
    exemption: p.exemption,
  };
}

/** The lines as the API takes them, or the first line that is not written right yet. */
export function toInputs(lines: EditLine[]): { inputs: LineInput[]; wrong: number | null } {
  const inputs: LineInput[] = [];
  for (const [i, l] of lines.entries()) {
    const quantity = parseQty(l.quantity);
    const unitPrice = parseMoney(l.unitPrice);
    if (quantity === null || unitPrice === null) return { inputs, wrong: i + 1 };
    inputs.push({
      product: l.product,
      code: l.code,
      name: l.name.trim() || undefined,
      description: l.description,
      quantity,
      unit: l.unit,
      unitPrice,
      discount: l.discount,
      kdvRate: l.kdvRate,
      withholding: l.kdvRate ? l.withholding : null,
      exemption: l.kdvRate ? null : l.exemption,
    });
  }
  return { inputs, wrong: null };
}

/** The server's totals for lines being written, asked again a moment after each change. */
export function usePreview(call: Call, request: Record<string, unknown> | null, t: T) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const body = request && JSON.stringify(request);
  const last = useRef(0);
  useEffect(() => {
    if (!body) return;
    const n = ++last.current;
    setPending(true);
    const timer = setTimeout(() => {
      void call<Preview>("/api/v1/invoices/preview", { method: "POST", body }).then(
        (p) => {
          if (n !== last.current) return;
          setPreview(p);
          setError(p.typeError);
          setPending(false);
        },
        (err: Error) => {
          if (n !== last.current) return;
          setError(err.message || t("common.failed"));
          setPending(false);
        },
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [call, body, t]);
  return { preview, error, pending: pending || !body };
}

export function LinesEditor({
  lines,
  setLines,
  settings,
  products,
  currency,
  locked,
  preview,
  t,
  locale,
}: {
  lines: EditLine[];
  setLines: (fn: (ls: EditLine[]) => EditLine[]) => void;
  settings: Settings;
  products: CatalogItem[];
  currency: string;
  /** A credit note: only the quantities change, and lines are taken out. */
  locked?: boolean;
  preview: Preview | null;
  t: T;
  locale?: string;
}) {
  const set = (key: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const exemptions = settings.exemptions;
  return (
    <ul aria-label={t("editor.draftLines")} className="inv-list flex flex-col">
      {lines.map((l, i) => {
        const n = i + 1;
        const total = preview && preview.lines.length === lines.length ? preview.lines[i] : undefined;
        const listed = products.filter((p) => p.active && (p.currency === currency || p.id === l.product));
        return (
          <li key={l.key} className="inv-line grid gap-2 border-b border-line px-3 py-2.5">
            <SelectField
              label={t("editor.line", { n })}
              value={l.product ?? ""}
              disabled={locked}
              onChange={(e) => {
                const p = products.find((x) => x.id === e.target.value);
                setLines((ls) =>
                  ls.map((x) =>
                    x.key === l.key ? (p ? { ...fromProduct(p, locale), key: x.key, quantity: x.quantity } : { ...x, product: null, code: null }) : x,
                  ),
                );
              }}
              options={[
                { value: "", label: l.product ? t("editor.writtenIn") : l.name || t("editor.writtenIn") },
                ...listed.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            <TextField label={t("editor.qty")} mono inputMode="decimal" value={l.quantity} onChange={(e) => set(l.key, { quantity: e.target.value })} />
            <TextField
              label={t("editor.price")}
              mono
              inputMode="decimal"
              value={l.unitPrice}
              disabled={locked}
              onChange={(e) => set(l.key, { unitPrice: e.target.value })}
              adornment={<span className="text-2xs text-fg-muted">{currency === "TRY" ? "TL" : currency}</span>}
            />
            <SelectField
              label={t("editor.kdv")}
              value={String(l.kdvRate)}
              disabled={locked}
              onChange={(e) => {
                const r = Number(e.target.value);
                set(l.key, r ? { kdvRate: r, exemption: null } : { kdvRate: 0, withholding: null, exemption: l.exemption ?? exemptions[0]?.code ?? null });
              }}
              options={settings.kdvRates.map((r) => ({ value: String(r), label: `${r}%` }))}
            />
            {l.kdvRate ? (
              <SelectField
                label={t("editor.withholding")}
                value={l.withholding ?? ""}
                disabled={locked}
                onChange={(e) => set(l.key, { withholding: e.target.value || null })}
                options={[
                  { value: "", label: t("editor.none") },
                  ...settings.withholding.map((w) => ({ value: w.code, label: `${w.code}, ${w.share}: ${w.name}` })),
                ]}
              />
            ) : (
              <SelectField
                label={t("editor.exemption")}
                value={l.exemption ?? ""}
                disabled={locked}
                onChange={(e) => set(l.key, { exemption: e.target.value || null })}
                options={exemptions.map((x) => ({ value: x.code, label: `${x.code}: ${x.name}` }))}
              />
            )}
            <IconButton label={t("editor.remove", { n })} size="sm" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
              <Trash2 className="size-3.5" />
            </IconButton>
            {!l.product && !locked && (
              <TextField className="inv-line-name" label={t("editor.name", { n })} value={l.name} onChange={(e) => set(l.key, { name: e.target.value })} />
            )}
            {total && (
              <p className="inv-line-total m-0 text-end text-2xs text-fg-muted">
                {t("editor.lineTotal", {
                  net: money(total.net, currency, locale),
                  kdv: money(total.kdv, currency, locale),
                })}
                {total.withheld > 0 && ` · ${t("editor.lineWithheld", { amount: money(total.withheld, currency, locale) })}`}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
