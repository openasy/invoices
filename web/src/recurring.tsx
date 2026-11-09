// Recurring invoices: the same lines every few months, issued on their day or kept as a draft to check first.
import { Button, Callout, DataTable, Dialog, PageHeader, Panel, SelectField, StatusBadge, Switch, TextField, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Ctx } from "./App.tsx";
import type { CatalogItem, Customer, Recurring } from "./api.ts";
import { day, money, Notice, patch, post, today, TotalsList, useLoad, type Note } from "./common.tsx";
import { useT } from "./i18n.ts";
import { fromLine, lineKey, LinesEditor, toInputs, usePreview, type EditLine } from "./lines.tsx";

function RecurringDialog({
  ctx,
  item,
  customers,
  products,
  open,
  onClose,
  onSaved,
}: {
  ctx: Ctx;
  item?: Recurring;
  customers: Customer[];
  products: CatalogItem[];
  open: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [name, setName] = useState("");
  const [customer, setCustomer] = useState("");
  const [every, setEvery] = useState("1");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState("");
  const [mode, setMode] = useState<"issue" | "draft">("issue");
  const [lines, setLines] = useState<EditLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? "");
    setCustomer(item?.customer ?? customers[0]?.id ?? "");
    setEvery(String(item?.everyMonths ?? 1));
    setStart(item?.start ?? today());
    setEnd(item?.end ?? "");
    setMode(item?.mode ?? "issue");
    setLines(item?.lines.map((l) => fromLine(l, locale)) ?? []);
    setError(null);
  }, [open, item, customers, locale]);
  const c = customers.find((x) => x.id === customer);
  const currency = item?.currency ?? c?.currency ?? ctx.settings.currency;
  const { inputs, wrong } = toInputs(lines);
  const {
    preview,
    error: previewError,
    pending,
  } = usePreview(ctx.call, open && customer && wrong === null && lines.length ? { customer, currency, lines: inputs } : null, t);
  const save = async () => {
    if (wrong !== null) return setError(t("editor.lineWrong", { n: wrong }));
    setBusy(true);
    setError(null);
    const body = {
      name,
      customer,
      lines: inputs,
      everyMonths: Number(every),
      ...(!item || start !== item.start ? { start } : {}),
      end: end || null,
      mode,
    };
    try {
      const r = item ? await ctx.call<Recurring>(`/api/v1/recurring/${item.id}`, patch(body)) : await ctx.call<Recurring>("/api/v1/recurring", post(body));
      onSaved(item ? t("recurring.saved", { name: r.name }) : t("recurring.added", { name: r.name }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!item) return;
    try {
      await ctx.call(`/api/v1/recurring/${item.id}`, { method: "DELETE" });
      onSaved(t("recurring.removed", { name: item.name }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const editor = can("editor");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={item ? item.name : t("recurring.new")}
      description={t("recurring.formDetail")}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      footer={
        <>
          {item && editor && (
            <Button type="button" variant="danger" className="mr-auto" onClick={() => void remove()}>
              {t("common.delete")}
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {editor && (
            <Button type="submit" variant="primary" loading={busy} disabled={!lines.length || !customer}>
              {t("common.save")}
            </Button>
          )}
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="inv-form2 mb-2.5 grid gap-2">
        <TextField label={t("recurring.name")} value={name} required onChange={(e) => setName(e.target.value)} hint={t("recurring.nameHint")} />
        <SelectField
          label={t("editor.customer")}
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          options={customers.map((x) => ({ value: x.id, label: x.name }))}
        />
        <SelectField
          label={t("recurring.every")}
          value={every}
          onChange={(e) => setEvery(e.target.value)}
          options={[1, 2, 3, 4, 6, 12, 24].map((n) => ({ value: String(n), label: t("recurring.everyN", { count: n }) }))}
        />
        <SelectField
          label={t("recurring.onTheDay")}
          value={mode}
          onChange={(e) => setMode(e.target.value as "issue" | "draft")}
          options={[
            { value: "issue", label: t("recurring.issueIt") },
            { value: "draft", label: t("recurring.keepDraft") },
          ]}
        />
        <TextField label={t("recurring.start")} type="date" value={start} onChange={(e) => setStart(e.target.value)} hint={t("recurring.startHint")} />
        <TextField label={t("recurring.end")} type="date" value={end} onChange={(e) => setEnd(e.target.value)} hint={t("recurring.endHint")} />
      </div>
      <div className="rounded-md border border-line">
        <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
          <span className="text-xs font-semibold">{t("editor.lines")}</span>
          <Button
            type="button"
            size="xs"
            icon={<Plus />}
            onClick={() => {
              const p = products.find((x) => x.active && x.currency === currency);
              setLines((ls) => [
                ...ls,
                p
                  ? fromLine(
                      {
                        product: p.id,
                        code: p.code,
                        name: p.name,
                        unit: p.unit,
                        quantity: 1,
                        unitPrice: p.unitPrice,
                        kdvRate: p.kdvRate,
                        withholding: p.withholding,
                        exemption: p.exemption,
                      },
                      locale,
                    )
                  : { ...fromLine({ name: "", quantity: 1, unitPrice: 0, kdvRate: 20 }, locale), key: lineKey() },
              ]);
            }}
          >
            {t("editor.addLine")}
          </Button>
        </div>
        {lines.length ? (
          <LinesEditor
            lines={lines}
            setLines={setLines}
            settings={ctx.settings}
            products={products}
            currency={currency}
            preview={preview}
            t={t}
            locale={locale}
          />
        ) : (
          <p className="m-0 px-3 py-3 text-sm text-fg-muted">{t("editor.noLines")}</p>
        )}
        {previewError && <p className="m-0 px-3 py-2 text-xs text-danger-text">{previewError}</p>}
        {preview && lines.length > 0 && (
          <TotalsList totals={preview.totals} currency={currency} home={ctx.settings.currency} t={t} locale={locale} pending={pending} />
        )}
      </div>
    </Dialog>
  );
}

export function RecurringPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [list, reload] = useLoad<{ recurring: Recurring[] }>(ctx.call, "/api/v1/recurring");
  const [customers] = useLoad<{ customers: Customer[] }>(ctx.call, "/api/v1/customers");
  const [catalog] = useLoad<{ items: CatalogItem[] }>(ctx.call, "/api/v1/catalog");
  const [note, setNote] = useState<Note>(null);
  const [editing, setEditing] = useState<Recurring | "new" | null>(null);
  const nameOf = (id: string) => customers?.customers.find((c) => c.id === id)?.name ?? "";
  const failing = (list?.recurring ?? []).filter((r) => r.lastError);
  const setMode = async (r: Recurring, issue: boolean) => {
    try {
      await ctx.call(`/api/v1/recurring/${r.id}`, patch({ mode: issue ? "issue" : "draft" }));
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    }
  };
  return (
    <>
      <PageHeader
        title={t("recurring.title")}
        description={t("recurring.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")} disabled={!customers?.customers.length}>
              {t("recurring.new")}
            </Button>
          )
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {failing.map((r) => (
        <Callout key={r.id} tone="warning" title={t("recurring.notIssued", { name: r.name })} className="mb-2.5">
          {r.lastError}{" "}
          {r.lastInvoice && (
            <a href={`/invoices/${r.lastInvoice}`} className="text-fg underline">
              {t("recurring.openDraft")}
            </a>
          )}
        </Callout>
      ))}
      <Panel flush>
        <DataTable
          label={t("recurring.label")}
          rows={list?.recurring ?? []}
          getRowId={(r) => r.id}
          minWidth={820}
          loading={list === undefined}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("recurring.none")}</p>}
          columns={[
            {
              id: "customer",
              header: t("col.customer"),
              sortValue: (r) => nameOf(r.customer),
              cell: (r) => (
                <button type="button" onClick={() => setEditing(r)} className="flex flex-col text-left">
                  <span className="font-medium text-fg hover:underline">{nameOf(r.customer)}</span>
                  <span className="text-2xs text-fg-muted">{r.name}</span>
                </button>
              ),
            },
            { id: "every", header: t("recurring.every"), cell: (r) => t("recurring.everyN", { count: r.everyMonths }) },
            {
              id: "next",
              header: t("recurring.next"),
              sortValue: (r) => r.next ?? "9999",
              cell: (r) => (r.active && r.next ? day(r.next, locale) : <StatusBadge tone="neutral">{t("recurring.ended")}</StatusBadge>),
            },
            { id: "made", header: t("recurring.made"), align: "right", mono: true, cell: (r) => r.made },
            {
              id: "amount",
              header: t("col.payable"),
              align: "right",
              mono: true,
              sortValue: (r) => r.totals?.payable ?? 0,
              cell: (r) => (r.totals ? money(r.totals.payable, r.currency, locale) : <span className="text-danger-text">{t("recurring.linesWrong")}</span>),
            },
            {
              id: "issue",
              header: t("recurring.onTheDay"),
              cell: (r) => (
                <Switch
                  label={r.mode === "issue" ? t("recurring.issueIt") : t("recurring.keepDraft")}
                  checked={r.mode === "issue"}
                  disabled={!can("editor")}
                  onCheckedChange={(v) => void setMode(r, v)}
                />
              ),
            },
          ]}
        />
      </Panel>
      <RecurringDialog
        ctx={ctx}
        open={editing !== null}
        item={editing && editing !== "new" ? editing : undefined}
        customers={customers?.customers ?? []}
        products={catalog?.items ?? []}
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
