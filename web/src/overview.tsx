// Overview: what customers owe and what is late, in the file's currency, all as the server summed it.
import { BarList, DataTable, KpiCard, KpiGrid, navigate, PageHeader, Panel, StackedBarChart, useLocalePreference } from "@openasy/ui";
import type { Ctx } from "./App.tsx";
import type { Overview } from "./api.ts";
import { money, monthName, useLoad } from "./common.tsx";
import { useT } from "./i18n.ts";

export function OverviewPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [o] = useLoad<Overview>(ctx.call, "/api/v1/overview");
  const m = (n: number) => money(n, o?.currency ?? ctx.settings.currency, locale);
  if (o === null) return <PageHeader title={t("overview.title")} description={t("common.failed")} />;
  if (!o) return <PageHeader title={t("overview.title")} description={t("loading")} />;
  const d = o.daysToPay;
  const change = d.last90 !== null && d.previous90 !== null ? d.last90 - d.previous90 : null;
  const waiting = o.waiting.drafts + o.waiting.refused;
  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description", { currency: o.currency === "TRY" ? "TL" : o.currency })} />
      <KpiGrid minWidth={170} className="mb-2.5">
        <KpiCard
          label={t("overview.owed")}
          value={m(o.owed.amount)}
          href="/invoices?show=owed"
          delta={{ label: t("overview.invoicesN", { count: o.owed.invoices }), intent: "neutral" }}
        />
        <KpiCard
          label={t("overview.overdue")}
          value={m(o.overdue.amount)}
          tone={o.overdue.amount ? "danger" : undefined}
          href="/invoices?show=overdue"
          delta={{
            label: o.overdue.invoices ? t("overview.overdueDetail", { count: o.overdue.invoices, days: o.overdue.oldestDays }) : t("overview.nothingLate"),
            intent: o.overdue.invoices ? "bad" : "good",
          }}
        />
        <KpiCard
          label={t("overview.collected", { month: monthName(o.collected.month, locale, true) })}
          value={m(o.collected.amount)}
          delta={{ label: t("overview.collectedDetail", { count: o.collected.payments, bank: o.collected.fromBank }), intent: "neutral" }}
        />
        <KpiCard
          label={t("overview.daysToPay")}
          value={d.last90 ?? "–"}
          delta={
            change === null
              ? { label: t("overview.daysToPayNone"), intent: "neutral" }
              : {
                  label: t("overview.daysToPayChange", { change: `${change > 0 ? "+" : ""}${change}` }),
                  direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
                  intent: change > 0 ? "bad" : change < 0 ? "good" : "neutral",
                }
          }
        />
        <KpiCard
          label={t("overview.waiting")}
          value={waiting}
          tone={waiting ? "warning" : undefined}
          href="/invoices?show=drafts"
          delta={{ label: t("overview.waitingDetail", { refused: o.waiting.refused, drafts: o.waiting.drafts }), intent: "neutral" }}
        />
      </KpiGrid>
      <div className="inv-side mb-2.5 grid gap-2.5">
        <Panel title={t("overview.byMonth")} description={t("overview.byMonthDetail")}>
          <StackedBarChart
            label={t("overview.byMonthLabel")}
            categories={o.months.map((x) => monthName(x.month, locale))}
            segments={[
              { id: "paid", name: t("overview.paid"), color: "var(--oa-success)" },
              { id: "owed", name: t("overview.stillOwed"), color: "var(--oa-warning)" },
            ]}
            values={o.months.map((x) => [x.paid, x.owed])}
            height={200}
            xTicks={6}
            format={m}
          />
        </Panel>
        <Panel title={t("overview.byAge")} description={t("overview.byAgeDetail")}>
          <BarList label={t("overview.byAge")} format={m} items={o.ages.map((a) => ({ id: a.age, label: t(`age.${a.age}`), value: a.amount }))} />
        </Panel>
      </div>
      <Panel title={t("overview.byCustomer")} flush>
        <DataTable
          label={t("overview.byCustomer")}
          rows={o.customers}
          getRowId={(r) => r.customer.id}
          defaultSort={{ id: "owed", direction: "desc" }}
          minWidth={640}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("overview.nobodyOwes")}</p>}
          columns={[
            { id: "name", header: t("col.customer"), sortValue: (r) => r.customer.name, cell: (r) => <span className="font-medium">{r.customer.name}</span> },
            { id: "invoices", header: t("col.invoices"), align: "right", mono: true, cell: (r) => r.invoices },
            { id: "owed", header: t("col.owed"), align: "right", mono: true, sortValue: (r) => r.owed, cell: (r) => m(r.owed) },
            {
              id: "overdue",
              header: t("col.overdue"),
              align: "right",
              mono: true,
              sortValue: (r) => r.overdue,
              cell: (r) => (r.overdue ? <span className="text-danger-text">{m(r.overdue)}</span> : <span className="text-fg-muted">–</span>),
            },
            {
              id: "oldest",
              header: t("col.oldest"),
              cell: (r) =>
                r.oldest ? (
                  <button type="button" onClick={() => navigate(`/invoices/${r.oldest!.id}`)} className="text-left text-xs text-fg hover:underline">
                    {t("overview.oldestLate", { number: r.oldest.number, count: r.oldest.daysOverdue })}
                  </button>
                ) : (
                  <span className="text-xs text-fg-muted">{t("overview.notDue")}</span>
                ),
            },
          ]}
        />
      </Panel>
    </>
  );
}
