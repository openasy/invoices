// Products and services with their unit, price and KDV, added one by one or from a CSV file. One on an issued invoice
// is taken off the list, not deleted.
import { Badge, Button, DataTable, Dialog, PageHeader, Panel, SelectField, Switch, TextField, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import type { Ctx } from "./App.tsx";
import type { CatalogItem, ImportResult } from "./api.ts";
import { FileButton, money, moneyInput, Notice, parseMoney, patch, post, readFile, useLoad, type Note } from "./common.tsx";
import { ImportErrors } from "./customers.tsx";
import { useT, viewerLocale } from "./i18n.ts";

interface Form {
  code: string;
  name: string;
  unit: string;
  price: string;
  currency: string;
  kdvRate: number;
  withholding: string;
  exemption: string;
  stock: boolean;
}

const formOf = (item: CatalogItem | undefined, currency: string, locale: string = viewerLocale()): Form => ({
  code: item?.code ?? "",
  name: item?.name ?? "",
  unit: item?.unit ?? "C62",
  price: item ? moneyInput(item.unitPrice, locale) : "",
  currency: item?.currency ?? currency,
  kdvRate: item?.kdvRate ?? 20,
  withholding: item?.withholding ?? "",
  exemption: item?.exemption ?? "",
  stock: item?.stock ?? false,
});

function ProductDialog({
  ctx,
  item,
  open,
  onClose,
  onSaved,
}: {
  ctx: Ctx;
  item?: CatalogItem;
  open: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const s = ctx.settings;
  const [f, setF] = useState<Form>(() => formOf(item, s.currency, locale));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF(formOf(item, s.currency, locale));
      setError(null);
    }
  }, [open, item, s.currency, locale]);
  const save = async () => {
    const unitPrice = parseMoney(f.price);
    if (unitPrice === null) return setError(t("products.wrongPrice"));
    setBusy(true);
    setError(null);
    const body = {
      code: f.code,
      name: f.name,
      unit: f.unit,
      unitPrice,
      currency: f.currency.toUpperCase(),
      kdvRate: f.kdvRate,
      withholding: f.kdvRate ? f.withholding || null : null,
      exemption: f.kdvRate ? null : f.exemption || null,
      stock: f.stock,
    };
    try {
      const p = item ? await ctx.call<CatalogItem>(`/api/v1/catalog/${item.id}`, patch(body)) : await ctx.call<CatalogItem>("/api/v1/catalog", post(body));
      onSaved(item ? t("products.saved", { name: p.name }) : t("products.added", { name: p.name }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!item) return;
    setBusy(true);
    try {
      await ctx.call(`/api/v1/catalog/${item.id}`, { method: "DELETE" });
      onSaved(t("products.removed", { name: item.name }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disabled = !can("editor");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={item ? item.name : t("products.new")}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      footer={
        <>
          {item && !disabled && (
            <Button type="button" variant="danger" className="mr-auto" disabled={busy} onClick={() => void remove()}>
              {t("products.takeOff")}
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {!disabled && (
            <Button type="submit" variant="primary" loading={busy}>
              {t("common.save")}
            </Button>
          )}
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="inv-form2 grid gap-2">
        <TextField label={t("products.code")} mono value={f.code} disabled={disabled} required onChange={(e) => setF({ ...f, code: e.target.value })} />
        <SelectField
          label={t("products.unit")}
          value={f.unit}
          disabled={disabled}
          onChange={(e) => setF({ ...f, unit: e.target.value })}
          options={s.units.map((u) => ({ value: u.code, label: `${u.name} (${u.code})` }))}
        />
        <div className="inv-span2">
          <TextField label={t("customers.name")} value={f.name} disabled={disabled} required onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <TextField
          label={t("products.price")}
          mono
          inputMode="decimal"
          value={f.price}
          disabled={disabled}
          required
          onChange={(e) => setF({ ...f, price: e.target.value })}
          hint={t("products.priceHint")}
        />
        <TextField
          label={t("customers.currency")}
          value={f.currency}
          maxLength={3}
          disabled={disabled}
          onChange={(e) => setF({ ...f, currency: e.target.value })}
        />
        <SelectField
          label={t("editor.kdv")}
          value={String(f.kdvRate)}
          disabled={disabled}
          onChange={(e) => {
            const r = Number(e.target.value);
            setF({ ...f, kdvRate: r, ...(r ? { exemption: "" } : { withholding: "", exemption: f.exemption || s.exemptions[0]?.code || "" }) });
          }}
          options={s.kdvRates.map((r) => ({ value: String(r), label: `${r}%` }))}
        />
        {f.kdvRate ? (
          <SelectField
            label={t("editor.withholding")}
            value={f.withholding}
            disabled={disabled}
            onChange={(e) => setF({ ...f, withholding: e.target.value })}
            options={[{ value: "", label: t("editor.none") }, ...s.withholding.map((w) => ({ value: w.code, label: `${w.code}, ${w.share}: ${w.name}` }))]}
          />
        ) : (
          <SelectField
            label={t("editor.exemption")}
            value={f.exemption}
            disabled={disabled}
            onChange={(e) => setF({ ...f, exemption: e.target.value })}
            options={s.exemptions.map((x) => ({ value: x.code, label: `${x.code}: ${x.name}` }))}
          />
        )}
        <div className="inv-span2">
          <Switch
            label={t("products.stock")}
            description={t("products.stockHint")}
            checked={f.stock}
            disabled={disabled}
            onCheckedChange={(v) => setF({ ...f, stock: v })}
          />
        </div>
      </div>
    </Dialog>
  );
}

export function ProductsPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [showAll, setShowAll] = useState(false);
  const [list, reload] = useLoad<{ items: CatalogItem[] }>(ctx.call, `/api/v1/catalog${showAll ? "?all=true" : ""}`);
  const [note, setNote] = useState<Note>(null);
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const unitName = (u: string) => ctx.settings.units.find((x) => x.code === u)?.name ?? u;
  const share = (code: string) => ctx.settings.withholding.find((w) => w.code === code)?.share;

  const importFile = async (file: File) => {
    setNote(null);
    setImported(null);
    try {
      const r = await ctx.call<ImportResult>("/api/v1/catalog/import", post({ content: await readFile(file) }));
      setImported(r);
      if (!r.errors.length) setNote({ text: t("import.done", { added: r.added, updated: r.updated, file: file.name }) });
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    }
  };

  return (
    <>
      <PageHeader
        title={t("products.title")}
        description={t("products.description")}
        actions={
          can("editor") && (
            <>
              <FileButton label={t("import.csv")} accept=".csv,text/csv" icon={<Upload className="size-3.5" />} onFile={(f) => void importFile(f)} />
              <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
                {t("products.new")}
              </Button>
            </>
          )
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <ImportErrors result={imported} t={t} />
      <div className="mb-2.5">
        <Switch label={t("products.showRemoved")} checked={showAll} onCheckedChange={setShowAll} />
      </div>
      <Panel flush footer={can("editor") ? t("products.csvHelp") : undefined}>
        <DataTable
          label={t("products.title")}
          rows={list?.items ?? []}
          getRowId={(p) => p.id}
          minWidth={760}
          loading={list === undefined}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("products.none")}</p>}
          columns={[
            { id: "code", header: t("products.code"), mono: true, sortValue: (p) => p.code, cell: (p) => p.code },
            {
              id: "name",
              header: t("customers.name"),
              sortValue: (p) => p.name,
              cell: (p) => (
                <button type="button" onClick={() => setEditing(p)} className="text-start text-fg hover:underline">
                  {p.name}
                  {!p.active && <span className="ms-1.5 text-2xs text-fg-muted">{t("products.offList")}</span>}
                </button>
              ),
            },
            { id: "unit", header: t("products.unit"), cell: (p) => `${unitName(p.unit)} (${p.unit})` },
            {
              id: "price",
              header: t("products.price"),
              align: "right",
              mono: true,
              sortValue: (p) => p.unitPrice,
              cell: (p) => money(p.unitPrice, p.currency, locale),
            },
            {
              id: "kdv",
              header: t("editor.kdv"),
              align: "right",
              mono: true,
              cell: (p) => (p.kdvRate ? `${p.kdvRate}%` : t("products.exempt", { code: p.exemption ?? "" })),
            },
            {
              id: "w",
              header: t("editor.withholding"),
              cell: (p) => (p.withholding ? <Badge>{`${p.withholding}, ${share(p.withholding) ?? ""}`}</Badge> : <span className="text-fg-muted">–</span>),
            },
            { id: "stock", header: t("products.stockShort"), cell: (p) => (p.stock ? <Badge tone="info">{t("products.counted")}</Badge> : "") },
          ]}
        />
      </Panel>
      <ProductDialog
        ctx={ctx}
        open={editing !== null}
        item={editing && editing !== "new" ? editing : undefined}
        onClose={() => setEditing(null)}
        onSaved={(text) => {
          setEditing(null);
          setNote({ text });
          reload();
        }}
      />
    </>
  );
}
