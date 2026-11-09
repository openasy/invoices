// A draft being written: a new invoice, a draft from CRM or a recurring invoice, a credit note, or an invoice the
// integrator refused. The totals, the type, the channel and the next number come from the server's preview; issuing
// saves the draft, then issues it.
import { Badge, Button, Callout, Dialog, navigate, PageHeader, Panel, SelectField, StatusBadge, TextField, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowLeft, Plus, Save, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Ctx } from "./App.tsx";
import type { CatalogItem, Customer, InvoiceDetail } from "./api.ts";
import { channelName, money, Notice, patch, post, StateBadge, TotalsList, useLoad, type Note } from "./common.tsx";
import { useT } from "./i18n.ts";
import { fromLine, lineKey, LinesEditor, toInputs, usePreview, type EditLine } from "./lines.tsx";

const CURRENCIES = ["TRY", "EUR", "USD", "GBP"];

export function InvoiceEditor({ id, initial, onDone, ...ctx }: Ctx & { id: string | null; initial?: InvoiceDetail; onDone?: () => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [customers] = useLoad<{ customers: Customer[] }>(ctx.call, "/api/v1/customers");
  const [catalog] = useLoad<{ items: CatalogItem[] }>(ctx.call, "/api/v1/catalog");
  const products = catalog?.items ?? [];
  const credit = initial?.kind === "credit_note";
  const refused = initial && (initial.status === "refused" || initial.status === "failed");
  const [customer, setCustomer] = useState(initial?.customer.id ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? ctx.settings.currency);
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<EditLine[]>(() => initial?.lines.map((l) => fromLine(l, locale)) ?? []);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  // A new invoice starts with the first customer and the first product in its currency, as people usually begin.
  useEffect(() => {
    if (initial || customer || !customers?.customers.length) return;
    const c = customers.customers[0]!;
    setCustomer(c.id);
    setCurrency(c.currency ?? ctx.settings.currency);
  }, [customers, customer, initial, ctx.settings.currency]);

  const c = customers?.customers.find((x) => x.id === customer);
  const { inputs, wrong } = toInputs(lines);
  const request =
    customer && wrong === null
      ? { customer, currency, lines: inputs, ...(credit && initial?.original ? { kind: "credit_note", original: initial.original.id } : {}) }
      : null;
  const { preview, error, pending } = usePreview(ctx.call, request, t);
  const next = refused ? initial!.number! : preview?.next;
  const editable = can("editor");

  const body = () => ({
    ...(!credit && { customer, currency }),
    lines: inputs,
    ...(!credit && { dueDate: dueDate || null }),
    notes: notes.trim() || null,
  });

  async function save(): Promise<string | null> {
    if (wrong !== null) {
      setNote({ text: t("editor.lineWrong", { n: wrong }), tone: "danger" });
      return null;
    }
    try {
      const saved = id
        ? await ctx.call<InvoiceDetail>(`/api/v1/invoices/${id}`, patch(body()))
        : await ctx.call<InvoiceDetail>("/api/v1/invoices", post(body()));
      ctx.onChanged();
      return saved.id;
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
      return null;
    }
  }

  async function saveOnly() {
    setBusy(true);
    setNote(null);
    const saved = await save();
    setBusy(false);
    if (!saved) return;
    if (!id) navigate(`/invoices/${saved}`);
    else setNote({ text: t("editor.saved") });
  }

  async function issue() {
    setBusy(true);
    setNote(null);
    const saved = await save();
    if (!saved) {
      setBusy(false);
      setConfirming(false);
      return;
    }
    try {
      await ctx.call(`/api/v1/invoices/${saved}/issue`, post({}));
      ctx.onChanged();
      if (id === saved && onDone) onDone();
      else navigate(`/invoices/${saved}`);
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
      setConfirming(false);
      if (!id) navigate(`/invoices/${saved}`);
    } finally {
      setBusy(false);
    }
  }

  const title = credit
    ? t("editor.creditTitle", { number: initial?.original?.number ?? "" })
    : refused
      ? t("editor.fixTitle", { number: initial!.number! })
      : id
        ? t("editor.draftTitle")
        : t("editor.newTitle");
  const channel = preview?.channel ?? null;
  const payable = preview?.totals.payable ?? 0;
  const owed = credit ? null : c?.owed.find((o) => o.currency === currency);
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t("invoices.title"), href: "/invoices" },
          { label: credit ? t("editor.newCredit") : (initial?.number ?? (id ? t("invoice.draft") : t("editor.newTitle"))) },
        ]}
        title={title}
        meta={initial ? <StateBadge status={initial.status} t={t} /> : <StatusBadge tone="neutral">{t("status.draft")}</StatusBadge>}
        actions={
          <>
            <Button icon={<ArrowLeft />} onClick={() => navigate(initial?.number ? `/invoices/${initial.id}` : "/invoices")}>
              {initial?.number ? t("editor.backToInvoice") : t("editor.back")}
            </Button>
            {editable && id && !initial?.number && (
              <Button icon={<Trash2 />} variant="ghost" onClick={() => setRemoving(true)}>
                {t("editor.deleteDraft")}
              </Button>
            )}
            {editable && (
              <Button icon={<Save />} disabled={busy || !customer || !lines.length} onClick={() => void saveOnly()}>
                {t("editor.save")}
              </Button>
            )}
            {editable && (
              <Button
                variant="primary"
                icon={<Send />}
                disabled={busy || pending || !!error || !lines.length || payable <= 0 || !preview}
                onClick={() => setConfirming(true)}
              >
                {refused ? t("editor.sendAgain") : t("editor.issue")}
              </Button>
            )}
          </>
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {refused && initial.integrator.detail && (
        <Callout tone="danger" title={t("invoice.refusedTitle")} className="mb-2.5">
          {initial.integrator.detail} {t("invoice.refusedDetail")}
        </Callout>
      )}
      <div className="inv-side grid gap-2.5">
        <Panel
          title={t("editor.lines")}
          aria-label={t("editor.lines")}
          actions={
            !credit &&
            editable && (
              <Button
                size="sm"
                icon={<Plus />}
                onClick={() =>
                  setLines((ls) => [
                    ...ls,
                    {
                      key: lineKey(),
                      product: null,
                      code: null,
                      name: "",
                      description: null,
                      unit: "C62",
                      quantity: "1",
                      unitPrice: "0",
                      discount: 0,
                      kdvRate: ctx.settings.kdvRates.includes(20) ? 20 : (ctx.settings.kdvRates.at(-1) ?? 20),
                      withholding: null,
                      exemption: null,
                    },
                  ])
                }
              >
                {t("editor.addLine")}
              </Button>
            )
          }
          flush
        >
          {lines.length ? (
            <LinesEditor
              lines={lines}
              setLines={setLines}
              settings={ctx.settings}
              products={products}
              currency={currency}
              locked={credit}
              preview={preview}
              t={t}
              locale={locale}
            />
          ) : (
            <p className="px-3 py-3 text-sm text-fg-muted">{t("editor.noLines")}</p>
          )}
          {wrong !== null ? (
            <p role="alert" className="m-0 px-3 py-2 text-xs text-danger-text">
              {t("editor.lineWrong", { n: wrong })}
            </p>
          ) : (
            error && (
              <p role="alert" className="m-0 px-3 py-2 text-xs text-danger-text">
                {error}
              </p>
            )
          )}
          {preview && <TotalsList totals={preview.totals} currency={currency} home={ctx.settings.currency} t={t} locale={locale} pending={pending} />}
        </Panel>
        <div className="flex flex-col gap-2.5">
          <Panel title={t("editor.customer")} aria-label={t("editor.customer")}>
            <div className="flex flex-col gap-2">
              <SelectField
                label={t("editor.customer")}
                value={customer}
                disabled={credit || !!refused}
                onChange={(e) => {
                  setCustomer(e.target.value);
                  const x = customers?.customers.find((y) => y.id === e.target.value);
                  if (x?.currency && !initial?.number) setCurrency(x.currency);
                }}
                options={[
                  ...(customer ? [] : [{ value: "", label: t("editor.pickCustomer") }]),
                  ...(customers?.customers ?? []).map((x) => ({ value: x.id, label: x.name })),
                ]}
              />
              {preview && (
                <p className="m-0 flex flex-wrap items-center gap-1.5 text-xs" aria-live="polite">
                  <Badge tone="info">{channelName(channel)}</Badge>
                  {credit
                    ? t("editor.channelCredit", { channel: channelName(channel) })
                    : !preview.channelKnown
                      ? t("editor.channelUnknown")
                      : channel === "e-fatura"
                        ? t("editor.channelEFatura", { alias: (preview.alias ?? "").replace("urn:mail:", "") })
                        : t("editor.channelEArsiv")}
                </p>
              )}
              {c && !credit && (!c.taxId || (c.taxId.length === 10 && !c.taxOffice) || !c.address.district) && (
                <p className="m-0 text-xs text-danger-text">
                  {t("editor.customerMissing")}{" "}
                  <a href={`/customers?open=${c.id}`} className="text-fg underline">
                    {t("editor.completeCustomer")}
                  </a>
                </p>
              )}
              {owed && owed.amount > 0 && (
                <p className="m-0 text-xs text-fg-muted">{t("editor.alreadyOwes", { amount: money(owed.amount, owed.currency, locale) })}</p>
              )}
              {next && (
                <p className="m-0 text-xs text-fg-muted">{refused ? t("editor.sameNumber", { number: next }) : t("editor.nextNumber", { number: next })}</p>
              )}
            </div>
          </Panel>
          {!credit && (
            <Panel title={t("editor.details")}>
              <div className="flex flex-col gap-2">
                <SelectField
                  label={t("editor.currency")}
                  value={currency}
                  disabled={!!initial?.number}
                  onChange={(e) => setCurrency(e.target.value)}
                  options={[...new Set([ctx.settings.currency, ...(c?.currency ? [c.currency] : []), ...CURRENCIES])].map((x) => ({ value: x, label: x }))}
                />
                {currency !== ctx.settings.currency && <p className="m-0 text-2xs text-fg-muted">{t("editor.rateNote")}</p>}
                <TextField
                  label={t("editor.due")}
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  hint={t("editor.dueHint", { days: c?.paymentDays ?? ctx.settings.paymentDays })}
                />
                <TextField label={t("editor.notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </Panel>
          )}
          <Callout tone="info" title={t("editor.beforeIssue")}>
            {t("editor.beforeIssueDetail")}
          </Callout>
        </div>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={refused ? t("editor.confirmAgain", { number: next ?? "" }) : t("editor.confirm", { number: next ?? "" })}
        description={t("editor.confirmDetail", {
          channel: channelName(channel),
          customer: c?.name ?? "",
          amount: money(payable, currency, locale),
          integrator: ctx.settings.integrator?.provider === "nilvera" ? "Nilvera" : t("editor.theIntegrator"),
        })}
        footer={
          <>
            <Button type="button" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void issue()}>
              {refused ? t("editor.sendAgain") : t("editor.issueNumber", { number: next ?? "" })}
            </Button>
          </>
        }
      >
        {next && <p className="m-0 text-xs text-fg-muted">{t("editor.numberCaveat")}</p>}
      </Dialog>
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("editor.deleteTitle")}
        description={t("editor.deleteDetail")}
        footer={
          <>
            <Button type="button" onClick={() => setRemoving(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                void ctx.call(`/api/v1/invoices/${id}`, { method: "DELETE" }).then(
                  () => {
                    ctx.onChanged();
                    navigate("/invoices");
                  },
                  (err: Error) => {
                    setRemoving(false);
                    setNote({ text: err.message, tone: "danger" });
                  },
                )
              }
            >
              {t("editor.deleteDraft")}
            </Button>
          </>
        }
      />
    </>
  );
}
