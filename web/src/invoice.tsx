// An invoice or credit note: its lines and totals as issued, payments, reminders, its way through the integrator to
// GİB, and what can be done with it. A draft, or a refused invoice being fixed, opens in the editor instead.
import {
  Badge,
  Button,
  Callout,
  cn,
  DataTable,
  Dialog,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  SelectField,
  StatusBadge,
  TextField,
  useLocalePreference,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowLeft, Ban, Banknote, FileCode, FileDown, FileMinus, Mail, Pencil, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Customer, InvoiceDetail, Payment } from "./api.ts";
import {
  channelName,
  day,
  money,
  moneyInput,
  Notice,
  parseMoney,
  post,
  qty,
  shortDay,
  StateBadge,
  today,
  TotalsList,
  useLoad,
  when,
  type Note,
} from "./common.tsx";
import { InvoiceEditor } from "./editor.tsx";
import { useT, type T } from "./i18n.ts";

const EDITABLE = ["draft", "refused", "failed"];
const OWED = ["queued", "waiting", "delivered", "accepted"];
/** What the server writes in an invoice's history, said in the page's language. */
const EVENTS = {
  drafted: "drafted",
  changed: "changed",
  issued: "issued",
  "issued again": "issued_again",
  "sent to the integrator": "sent_to_the_integrator",
  waiting: "waiting",
  delivered: "delivered",
  accepted: "accepted",
  rejected: "rejected",
  refused: "refused",
  failed: "failed",
  cancelled: "cancelled",
  emailed: "emailed",
  "email failed": "email_failed",
  reminded: "reminded",
  "reminder failed": "reminder_failed",
  payment: "payment",
  "payment removed": "payment_removed",
  "credit note drafted": "credit_note_drafted",
  "not issued": "not_issued",
} as const;
const eventKey = (what: string) => (what in EVENTS ? EVENTS[what as keyof typeof EVENTS] : null);

export function InvoicePage({ id, edit, ...ctx }: Ctx & { id: string; edit: boolean }) {
  const t = useT();
  const [inv, reload] = useLoad<InvoiceDetail>(ctx.call, `/api/v1/invoices/${encodeURIComponent(id)}`);
  if (inv === null) return <PageHeader breadcrumbs={[{ label: t("invoices.title"), href: "/invoices" }]} title={t("invoice.missing")} />;
  if (!inv) return <PageHeader title={t("loading")} />;
  if (inv.status === "draft" || (edit && EDITABLE.includes(inv.status)))
    return <InvoiceEditor key={inv.id} {...ctx} id={inv.id} initial={inv} onDone={() => (edit ? navigate(`/invoices/${inv.id}`) : reload())} />;
  return <InvoiceView {...ctx} inv={inv} reload={reload} />;
}

function sourceText(inv: InvoiceDetail, t: T) {
  if (inv.kind === "credit_note") return t("source.credit", { number: inv.original?.number ?? "" });
  if (inv.source === "crm") return t("source.crm");
  if (inv.source === "recurring") return t("source.recurring");
  return t("source.manual");
}

function Steps({ inv, t, locale }: { inv: InvoiceDetail; t: T; locale?: string }) {
  const at = (what: string) => inv.events.find((e) => e.what === what)?.at;
  const s = inv.status;
  const sent = ["waiting", "delivered", "accepted", "rejected", "cancelled"].includes(s);
  const arrived = ["delivered", "accepted", "rejected", "cancelled"].includes(s);
  const steps = [
    { id: "drafted", label: t("steps.drafted"), by: t("steps.draftedBy", { by: inv.createdBy, when: when(inv.createdAt, locale) }), done: true },
    {
      id: "numbered",
      label: inv.number ? t("steps.numbered", { number: inv.number }) : t("steps.notNumbered"),
      by: inv.issuedAt ? t("steps.numberedBy", { by: inv.issuedBy ?? "", when: when(inv.issuedAt, locale) }) : t("steps.onIssue"),
      done: !!inv.number,
    },
    {
      id: "sent",
      label: t("steps.sent"),
      by: at("sent to the integrator") ? when(at("sent to the integrator")!, locale) : t("steps.checkedFirst"),
      done: sent,
    },
    {
      id: "arrived",
      label: inv.channel === "e-arsiv" ? t("steps.reported") : t("steps.delivered"),
      by: t(`statusMeans.${s}`),
      done: arrived,
    },
    ...(inv.profile === "TICARIFATURA"
      ? [
          {
            id: "answer",
            label: s === "rejected" ? t("steps.rejected") : t("steps.accepted"),
            by: t("steps.eightDays"),
            done: s === "accepted" || s === "rejected",
          },
        ]
      : []),
  ];
  return (
    <ol aria-label={t("steps.label")} className="inv-list flex flex-col gap-1.5 text-xs">
      {steps.map((x) => (
        <li key={x.id} className="flex items-start gap-2">
          <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", x.done ? "bg-success" : "bg-line-strong")} />
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">
              {x.label}
              <span className="sr-only">{x.done ? t("steps.done") : t("steps.notYet")}</span>
            </span>
            <span className="text-2xs text-fg-muted">{x.by}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function InvoiceView({ inv, reload, ...ctx }: Ctx & { inv: InvoiceDetail; reload: () => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [buyer] = useLoad<Customer>(ctx.call, `/api/v1/customers/${inv.customer.id}`);
  const [note, setNote] = useState<Note>(null);
  const [dialog, setDialog] = useState<null | "pay" | "credit" | "cancel" | "again">(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<Payment["method"]>("bank");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const m = (n: number) => money(n, inv.currency, locale);
  const credit = inv.kind === "credit_note";
  const owed = !credit && OWED.includes(inv.status);
  const refused = inv.status === "refused" || inv.status === "failed";
  const editor = can("editor");
  const done = (text: string) => {
    setNote({ text });
    reload();
    ctx.onChanged();
  };
  const fail = (err: Error) => setNote({ text: err.message, tone: "danger" });
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      fail(err as Error);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };
  const terms = inv.issueDate && inv.dueDate ? Math.round((Date.parse(inv.dueDate) - Date.parse(inv.issueDate)) / 86_400_000) : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("invoices.title"), href: "/invoices" }, { label: inv.number ?? t("invoice.draft") }]}
        title={t(credit ? "invoice.creditTitle" : "invoice.title", { number: inv.number ?? "" })}
        meta={
          <>
            <StateBadge status={inv.status} t={t} />
            {inv.overdue && <StatusBadge tone="danger">{t("invoice.daysLate", { count: inv.daysOverdue })}</StatusBadge>}
            {owed && inv.balance === 0 && <StatusBadge tone="success">{t("invoice.paid")}</StatusBadge>}
          </>
        }
        description={[inv.customer.name, [channelName(inv.channel), inv.profile, inv.type].filter(Boolean).join(", "), sourceText(inv, t)].join(" · ")}
        actions={
          <>
            <Button icon={<ArrowLeft />} onClick={() => navigate("/invoices")}>
              {t("editor.back")}
            </Button>
            {editor && refused && (
              <>
                <Button icon={<Pencil />} onClick={() => navigate(`/invoices/${inv.id}/edit`)}>
                  {t("invoice.change")}
                </Button>
                <Button variant="primary" icon={<Send />} onClick={() => setDialog("again")}>
                  {t("invoice.fixSend")}
                </Button>
              </>
            )}
            {editor && inv.channel === "e-arsiv" && ["waiting", "delivered"].includes(inv.status) && inv.paid === 0 && (
              <Button icon={<Ban />} variant="ghost" onClick={() => setDialog("cancel")}>
                {t("invoice.cancel")}
              </Button>
            )}
            {editor && owed && (
              <>
                <Button icon={<FileMinus />} onClick={() => setDialog("credit")}>
                  {t("invoice.creditNote")}
                </Button>
                {inv.balance > 0 && (
                  <Button
                    icon={<Mail />}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await ctx.call<InvoiceDetail>(`/api/v1/invoices/${inv.id}/email`, post({ kind: "reminder" }));
                        const to = r.events.at(-1)?.detail ?? "";
                        done(t("invoice.reminded", { to }));
                      })
                    }
                  >
                    {t("invoice.remind")}
                  </Button>
                )}
                {inv.balance > 0 && (
                  <Button
                    variant="primary"
                    icon={<Banknote />}
                    onClick={() => {
                      setAmount(moneyInput(inv.balance, locale));
                      setDate(today());
                      setReference("");
                      setDialog("pay");
                    }}
                  >
                    {t("invoice.recordPayment")}
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {(refused || inv.status === "rejected") && inv.integrator.detail && (
        <Callout tone="danger" title={inv.status === "rejected" ? t("invoice.rejectedTitle") : t("invoice.refusedTitle")} className="mb-2.5">
          {inv.integrator.detail} {refused && t("invoice.refusedDetail")}
        </Callout>
      )}
      {!refused && inv.integrator.attempts > 0 && inv.integrator.detail && (
        <Callout tone="warning" title={t("invoice.retrying", { count: inv.integrator.attempts })} className="mb-2.5">
          {inv.integrator.detail}
        </Callout>
      )}
      <div className="inv-side grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <KpiGrid minWidth={150}>
            <KpiCard label={t("totals.payable")} value={m(inv.totals.payable)} />
            {!credit && <KpiCard label={t("invoice.paidKpi")} value={m(inv.paid)} />}
            {!credit && inv.credited > 0 && <KpiCard label={t("invoice.credited")} value={m(inv.credited)} />}
            {!credit && <KpiCard label={t("invoice.left")} value={m(inv.balance)} tone={inv.overdue ? "danger" : undefined} />}
            {!credit && (
              <KpiCard
                label={t("invoice.due")}
                value={inv.dueDate ? day(inv.dueDate, locale) : "–"}
                unit={terms !== null ? t("invoice.termsDays", { count: terms }) : undefined}
              />
            )}
            {credit && inv.issueDate && <KpiCard label={t("col.issued")} value={day(inv.issueDate, locale)} />}
          </KpiGrid>
          <Panel
            title={t("editor.lines")}
            aria-label={t("editor.lines")}
            actions={
              <>
                <Button size="sm" icon={<FileDown />} onClick={() => window.location.assign(inv.pdf)}>
                  PDF
                </Button>
                {inv.xml && (
                  <Button size="sm" icon={<FileCode />} onClick={() => window.location.assign(inv.xml!)}>
                    {t("invoice.xml")}
                  </Button>
                )}
              </>
            }
            flush
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-start text-sm">
                <caption className="sr-only">{t("invoice.linesCaption")}</caption>
                <thead className="bg-canvas text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-1.5 font-semibold">{t("col.item")}</th>
                    <th className="px-3 py-1.5 text-end font-semibold">{t("editor.qty")}</th>
                    <th className="px-3 py-1.5 text-end font-semibold">{t("editor.price")}</th>
                    <th className="px-3 py-1.5 text-end font-semibold">{t("editor.kdv")}</th>
                    <th className="px-3 py-1.5 text-end font-semibold">{t("col.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-3 py-1.5">
                        {l.name}
                        {l.discount > 0 && <span className="block text-2xs text-fg-muted">{t("invoice.discount", { pct: l.discount })}</span>}
                        {l.withholding && (
                          <span className="block text-2xs text-fg-muted">
                            {t("invoice.tevkifat", { code: l.withholding.code, share: l.withholding.share })}
                          </span>
                        )}
                        {l.exemption && (
                          <span className="block text-2xs text-fg-muted">
                            {t("invoice.exempt", { code: l.exemption, name: ctx.settings.exemptions.find((x) => x.code === l.exemption)?.name ?? "" })}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-end font-mono text-xs">
                        {qty(l.quantity, locale)} {ctx.settings.units.find((u) => u.code === l.unit)?.name.toLocaleLowerCase(locale) ?? l.unit}
                      </td>
                      <td className="px-3 py-1.5 text-end font-mono text-xs">{m(l.unitPrice)}</td>
                      <td className="px-3 py-1.5 text-end font-mono text-xs">{l.kdvRate}%</td>
                      <td className="px-3 py-1.5 text-end font-mono text-xs">{m(l.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line">
              <TotalsList
                totals={inv.totals}
                currency={inv.currency}
                rate={inv.rate?.value}
                tryPayable={inv.tryTotals?.payable}
                home={ctx.settings.currency}
                t={t}
                locale={locale}
              />
            </div>
          </Panel>
          {!credit && inv.number && (
            <Panel title={t("invoice.payments")} aria-label={t("invoice.payments")} flush>
              <DataTable
                label={t("invoice.payments")}
                rows={inv.payments}
                getRowId={(p) => p.id}
                minWidth={520}
                empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("invoice.noPayments")}</p>}
                columns={[
                  { id: "date", header: t("col.date"), cell: (p) => day(p.date, locale) },
                  { id: "amount", header: t("col.amount"), align: "right", mono: true, cell: (p) => m(p.amount) },
                  { id: "method", header: t("col.how"), cell: (p) => <Badge>{t(`method.${p.method}`)}</Badge> },
                  {
                    id: "note",
                    header: t("col.note"),
                    cell: (p) => (
                      <span className="text-fg-muted">{[p.note, p.reference].filter(Boolean).join(" · ") || t("invoice.by", { by: p.createdBy })}</span>
                    ),
                  },
                  {
                    id: "remove",
                    header: <span className="sr-only">{t("common.remove")}</span>,
                    align: "right",
                    cell: (p) =>
                      editor && (
                        <IconButton
                          label={t("invoice.removePayment", { amount: m(p.amount) })}
                          size="xs"
                          onClick={() =>
                            void act(async () => {
                              await ctx.call(`/api/v1/payments/${p.id}`, { method: "DELETE" });
                              done(t("invoice.paymentRemoved"));
                            })
                          }
                        >
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      ),
                  },
                ]}
              />
            </Panel>
          )}
          {inv.creditNotes.length > 0 && (
            <Panel title={t("invoice.creditNotes")} aria-label={t("invoice.creditNotes")}>
              <ul className="inv-list flex flex-col gap-1 text-xs">
                {inv.creditNotes.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <a href={`/invoices/${c.id}`} className="font-mono text-fg hover:underline">
                      {c.number ?? t("invoice.draft")}
                    </a>
                    <span className="flex items-center gap-2">
                      <span className="font-mono">−{m(c.payable)}</span>
                      <StateBadge status={c.status as InvoiceDetail["status"]} t={t} />
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
        <div className="flex flex-col gap-2.5">
          <Panel
            title={t("invoice.atGib")}
            description={
              ctx.settings.integrator
                ? t("invoice.through", { integrator: ctx.settings.integrator.provider === "nilvera" ? "Nilvera" : t("integrations.fake") })
                : undefined
            }
          >
            <Steps inv={inv} t={t} locale={locale} />
          </Panel>
          <Panel title={t("invoice.buyer")}>
            <dl className="inv-facts grid gap-x-2 gap-y-1 text-xs">
              <dt className="text-fg-muted">{t("customers.name")}</dt>
              <dd className="m-0 text-fg">{buyer?.name ?? inv.customer.name}</dd>
              <dt className="text-fg-muted">{buyer?.taxId?.length === 11 ? "TCKN" : "VKN"}</dt>
              <dd className="m-0 font-mono text-fg">{buyer?.taxId ?? "–"}</dd>
              <dt className="text-fg-muted">{t("customers.taxOffice")}</dt>
              <dd className={cn("m-0", buyer && !buyer.taxOffice && buyer.taxId?.length === 10 ? "text-danger-text" : "text-fg")}>
                {buyer?.taxOffice || (buyer?.taxId?.length === 10 ? t("customers.missing") : "–")}
              </dd>
              <dt className="text-fg-muted">{t("invoice.mailbox")}</dt>
              <dd className="m-0 truncate font-mono text-2xs text-fg">{inv.alias ?? buyer?.eInvoice?.aliases[0] ?? t("invoice.noMailbox")}</dd>
            </dl>
            {editor && (refused || inv.status === "draft") && (
              <a href={`/customers?open=${inv.customer.id}`} className="mt-2 block text-xs">
                {t("invoice.editBuyer")}
              </a>
            )}
          </Panel>
          {owed && inv.reminderPlan.length > 0 && (
            <Panel title={t("invoice.reminders")} description={t("invoice.remindersDetail")}>
              {!ctx.settings.mail && <p className="mb-1.5 text-xs text-warning-text">{t("invoice.noMail")}</p>}
              <ul aria-label={t("invoice.reminders")} className="inv-list flex flex-col gap-1 text-xs">
                {inv.reminderPlan.map((r) => (
                  <li key={`${r.kind}${r.days}`} className="flex items-center justify-between gap-2">
                    <span>
                      {shortDay(r.on, locale)}, {ctx.settings.reminders.at} ·{" "}
                      <span className="text-fg-muted">{t(r.kind === "before" ? "invoice.before" : "invoice.after", { count: r.days })}</span>
                    </span>
                    <Badge tone={r.state === "sent" ? "success" : r.state === "failed" ? "danger" : "neutral"}>{t(`reminder.${r.state}`)}</Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title={t("invoice.history")}>
            <ul aria-label={t("invoice.history")} className="inv-list flex flex-col gap-1 text-xs">
              {inv.events.map((e, i) => (
                <li key={i} className="flex flex-col">
                  <span className="text-fg">
                    {eventKey(e.what) ? t(`event.${eventKey(e.what)!}`) : e.what}
                    {e.detail && <span className="text-fg-muted">: {e.detail}</span>}
                  </span>
                  <span className="text-2xs text-fg-muted">
                    {when(e.at, locale)}, {e.by}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
      <Dialog
        open={dialog === "pay"}
        onOpenChange={(o) => setDialog(o ? "pay" : null)}
        title={t("pay.title", { number: inv.number ?? "" })}
        description={t("pay.detail", { amount: m(inv.balance) })}
        onSubmit={(e) => {
          e.preventDefault();
          const n = parseMoney(amount);
          if (n === null || n <= 0) return setNote({ text: t("pay.wrongAmount"), tone: "danger" });
          void act(async () => {
            await ctx.call(`/api/v1/invoices/${inv.id}/payments`, post({ amount: n, date, method, reference: reference.trim() || null }));
            const after = await ctx.call<InvoiceDetail>(`/api/v1/invoices/${inv.id}`);
            done(after.balance > 0 ? t("pay.partly", { amount: m(n), left: m(after.balance) }) : t("pay.full", { number: inv.number ?? "" }));
          });
        }}
        footer={
          <>
            <Button type="button" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {t("pay.record")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <TextField
            label={t("col.amount")}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            mono
            inputMode="decimal"
            adornment={<span className="text-xs text-fg-muted">{inv.currency}</span>}
          />
          <TextField label={t("col.date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <SelectField
            label={t("col.how")}
            value={method}
            onChange={(e) => setMethod(e.target.value as Payment["method"])}
            options={(["bank", "cash", "card", "other"] as const).map((x) => ({ value: x, label: t(`methodLong.${x}`) }))}
          />
          <TextField label={t("pay.reference")} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </Dialog>
      <Dialog
        open={dialog === "credit"}
        onOpenChange={(o) => setDialog(o ? "credit" : null)}
        title={t("credit.title", { number: inv.number ?? "" })}
        description={t("credit.detail")}
        footer={
          <>
            <Button type="button" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void act(async () => {
                  const cn = await ctx.call<InvoiceDetail>(`/api/v1/invoices/${inv.id}/credit-notes`, post({}));
                  ctx.onChanged();
                  navigate(`/invoices/${cn.id}`);
                })
              }
            >
              {t("credit.draft")}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm">{t("credit.body", { number: inv.number ?? "" })}</p>
      </Dialog>
      <Dialog
        open={dialog === "cancel"}
        onOpenChange={(o) => setDialog(o ? "cancel" : null)}
        title={t("cancel.title", { number: inv.number ?? "" })}
        description={t("cancel.detail")}
        footer={
          <>
            <Button type="button" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void act(async () => {
                  await ctx.call(`/api/v1/invoices/${inv.id}/cancel`, post());
                  done(t("cancel.done", { number: inv.number ?? "" }));
                })
              }
            >
              {t("invoice.cancel")}
            </Button>
          </>
        }
      />
      <Dialog
        open={dialog === "again"}
        onOpenChange={(o) => setDialog(o ? "again" : null)}
        title={t("editor.confirmAgain", { number: inv.number ?? "" })}
        description={t("again.detail")}
        footer={
          <>
            <Button type="button" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void act(async () => {
                  await ctx.call(`/api/v1/invoices/${inv.id}/issue`, post({}));
                  done(t("again.done", { number: inv.number ?? "" }));
                })
              }
            >
              {t("editor.sendAgain")}
            </Button>
          </>
        }
      />
    </>
  );
}
