// Invoices: every invoice and credit note with its state at GİB and what is left to pay, filtered as people look for them.
import { Button, DataTable, navigate, PageHeader, Panel, SearchInput, SegmentedControl, useLocalePreference, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Invoice } from "./api.ts";
import { channelName, day, money, StateBadge, useLoad } from "./common.tsx";
import { useT } from "./i18n.ts";

const FILTERS = ["all", "owed", "overdue", "drafts", "credit"] as const;
type Filter = (typeof FILTERS)[number];

export function InvoicesPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const initial = new URLSearchParams(window.location.search).get("show");
  const [filter, setFilter] = useState<Filter>((FILTERS as readonly string[]).includes(initial ?? "") ? (initial as Filter) : "all");
  const [query, setQuery] = useState("");
  const [list] = useLoad<{ invoices: Invoice[] }>(ctx.call, "/api/v1/invoices");
  const q = query.trim().toLocaleLowerCase(locale);
  const rows = (list?.invoices ?? []).filter((i) => {
    if (q && !`${i.number ?? ""} ${i.customer.name}`.toLocaleLowerCase(locale).includes(q)) return false;
    if (filter === "owed") return i.balance > 0;
    if (filter === "overdue") return i.overdue;
    if (filter === "drafts") return i.status === "draft" || i.status === "refused" || i.status === "failed";
    if (filter === "credit") return i.kind === "credit_note";
    return true;
  });
  const cols: Column<Invoice>[] = [
    {
      id: "number",
      header: t("col.number"),
      width: "20%",
      sortValue: (i) => i.number ?? "",
      cell: (i) => (
        <a href={`/invoices/${i.id}`} className="font-mono text-xs text-fg hover:underline">
          {i.number ?? t("invoice.draft")}
        </a>
      ),
    },
    {
      id: "customer",
      header: t("col.customer"),
      sortValue: (i) => i.customer.name,
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{i.customer.name}</span>
          <span className="text-2xs text-fg-muted">
            {i.kind === "credit_note"
              ? t("invoice.creditNoteFor", { number: i.original?.number ?? "" })
              : [channelName(i.channel), i.type].filter(Boolean).join(" · ") || t("invoice.notIssued")}
          </span>
        </span>
      ),
    },
    { id: "status", header: t("col.state"), sortValue: (i) => i.status, cell: (i) => <StateBadge status={i.status} t={t} /> },
    { id: "issued", header: t("col.issued"), sortValue: (i) => i.issueDate ?? "", cell: (i) => (i.issueDate ? day(i.issueDate, locale) : "–") },
    {
      id: "due",
      header: t("col.due"),
      sortValue: (i) => i.dueDate ?? "",
      cell: (i) =>
        i.overdue ? (
          <span className="text-danger-text">{t("invoice.daysLate", { count: i.daysOverdue })}</span>
        ) : (
          <span className="text-fg-muted">{i.dueDate && i.kind === "invoice" ? day(i.dueDate, locale) : "–"}</span>
        ),
    },
    {
      id: "total",
      header: t("col.payable"),
      align: "right",
      mono: true,
      sortValue: (i) => i.tryTotals?.payable ?? i.totals.payable,
      cell: (i) => `${i.kind === "credit_note" ? "−" : ""}${money(i.totals.payable, i.currency, locale)}`,
    },
    {
      id: "left",
      header: t("col.left"),
      align: "right",
      mono: true,
      sortValue: (i) => i.balance,
      cell: (i) => (i.balance ? money(i.balance, i.currency, locale) : "–"),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("invoices.title")}
        description={t("invoices.description", { eFatura: ctx.settings.series.eFatura, eArsiv: ctx.settings.series.eArsiv })}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => navigate("/invoices/new")}>
              {t("invoices.new")}
            </Button>
          )
        }
      />
      <div className="mb-2.5 flex flex-wrap items-end gap-2">
        <SegmentedControl
          label={t("invoices.show")}
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f, label: t(`invoices.filter.${f}`) }))}
        />
        <SearchInput
          label={t("invoices.search")}
          placeholder={t("invoices.searchHint")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-64"
        />
      </div>
      <Panel flush>
        <DataTable
          label={t("invoices.title")}
          columns={cols}
          rows={rows}
          getRowId={(i) => i.id}
          minWidth={900}
          loading={list === undefined}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{list === null ? t("common.failed") : t("invoices.none")}</p>}
        />
      </Panel>
    </>
  );
}
