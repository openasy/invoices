// Exports for the accountant: the invoices, the payments and the UBL-TR XML of a month, as the server writes them.
import { IconButton, PageHeader, Panel, SelectField, useLocalePreference } from "@openasy/ui";
import { FileDown } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { ExportCounts } from "./api.ts";
import { monthName, Notice, today, useLoad } from "./common.tsx";
import { useT } from "./i18n.ts";

/** This month so far and the eleven before it, as { from, to }. */
function periods(now: string) {
  const [y, m] = now.split("-").map(Number) as [number, number];
  return Array.from({ length: 12 }, (_x, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const month = d.toISOString().slice(0, 7);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { month, from: `${month}-01`, to: i === 0 ? now : last, current: i === 0 };
  });
}

export function ExportsPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const list = periods(today());
  const [month, setMonth] = useState(list[1]!.month);
  const p = list.find((x) => x.month === month)!;
  const q = new URLSearchParams({ from: p.from, to: p.to });
  const [counts] = useLoad<ExportCounts>(ctx.call, `/api/v1/exports/counts?${q}`);
  const [done, setDone] = useState<string | null>(null);
  const label = (x: (typeof list)[number]) => (x.current ? t("exports.soFar", { month: monthName(x.month, locale, true) }) : monthName(x.month, locale, true));
  const files = [
    {
      id: "invoices",
      name: t("exports.invoices"),
      file: `faturalar-${p.from}-${p.to}.csv`,
      href: `/api/v1/exports/invoices.csv?${q}`,
      text: t("exports.invoicesDetail"),
      count: counts && t("exports.invoicesCount", { count: counts.invoices, credit: counts.creditNotes }),
    },
    {
      id: "payments",
      name: t("exports.payments"),
      file: `tahsilatlar-${p.from}-${p.to}.csv`,
      href: `/api/v1/exports/payments.csv?${q}`,
      text: t("exports.paymentsDetail"),
      count: counts && t("exports.paymentsCount", { count: counts.payments }),
    },
    {
      id: "ubl",
      name: t("exports.ubl"),
      file: `ubl-${p.from}-${p.to}.zip`,
      href: `/api/v1/exports/ubl.zip?${q}`,
      text: t("exports.ublDetail"),
      count: counts && t("exports.ublCount", { count: counts.xml }),
    },
  ];
  return (
    <>
      <PageHeader title={t("exports.title")} description={t("exports.description")} />
      <div className="mb-2.5 w-56">
        <SelectField
          label={t("exports.period")}
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setDone(null);
          }}
          options={list.map((x) => ({ value: x.month, label: label(x) }))}
        />
      </div>
      {done && <Notice>{t("exports.downloaded", { file: done, period: label(p) })}</Notice>}
      <div className="inv-thirds grid gap-2.5">
        {files.map((f) => (
          <Panel
            key={f.id}
            title={f.name}
            description={f.file}
            aria-label={f.name}
            footer={f.count ?? t("loading")}
            actions={
              <IconButton
                label={t("exports.download", { file: f.file })}
                size="xs"
                onClick={() => {
                  window.location.assign(f.href);
                  setDone(f.file);
                }}
              >
                <FileDown className="size-3.5" />
              </IconButton>
            }
          >
            <p className="m-0 text-sm text-fg">{f.text}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}
