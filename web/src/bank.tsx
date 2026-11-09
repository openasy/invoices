// Bank: statements imported from the accounts in invoices.yaml. A line that names an invoice number, or pays exactly what
// a customer owes and names them, is matched by the server; the rest wait here to be matched or ignored.
import { Button, Callout, DataTable, Dialog, PageHeader, Panel, SegmentedControl, SelectField, StatusBadge, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Upload } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { BankLine, Invoice, Statement, StatementResult } from "./api.ts";
import { Code, day, FileButton, money, Notice, post, readFile, shortDay, useLoad, when, type Note } from "./common.tsx";
import { useT } from "./i18n.ts";

const TONE = { matched: "success", unmatched: "warning", ignored: "neutral", outgoing: "neutral" } as const;
type Show = "all" | "unmatched";

const fold = (s: string) => s.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}]+/gu, " ");

/** The owed invoice a line most likely pays, to start the choice with: its exact amount, or its customer named. */
function guess(line: BankLine, owed: Invoice[]): string {
  const text = fold(line.description);
  const named = owed.filter(
    (i) =>
      i.customer.name &&
      fold(i.customer.name)
        .split(" ")
        .filter((w) => w.length > 3)
        .some((w) => text.includes(w)),
  );
  return (named.find((i) => i.balance === line.amount) ?? owed.find((i) => i.balance === line.amount) ?? named[0] ?? owed[0])?.id ?? "";
}

export function BankPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [show, setShow] = useState<Show>("all");
  const [lines, reloadLines] = useLoad<{ lines: BankLine[] }>(ctx.call, "/api/v1/bank/lines?state=all");
  const [statements, reloadStatements] = useLoad<{ statements: Statement[] }>(ctx.call, "/api/v1/bank/statements");
  const [owedList, reloadOwed] = useLoad<{ invoices: Invoice[] }>(ctx.call, "/api/v1/invoices?status=owed");
  const [note, setNote] = useState<Note>(null);
  const [matching, setMatching] = useState<BankLine | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState(ctx.settings.bank[0]?.id ?? "");
  const reload = () => {
    reloadLines();
    reloadStatements();
    reloadOwed();
    ctx.onChanged();
  };
  const owed = (owedList?.invoices ?? []).filter((i) => !matching || i.currency === matching.currency);

  const importFile = async (file: File) => {
    setNote(null);
    try {
      const r = await ctx.call<StatementResult>("/api/v1/bank/statements", post({ account, filename: file.name, content: await readFile(file) }));
      setNote({ text: t("bank.imported", { file: file.name, added: r.added, matched: r.matched, unmatched: r.unmatched, duplicates: r.duplicates }) });
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    }
  };

  const resolve = async (line: BankLine, body: { invoice: string } | { ignore: true }) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await ctx.call<BankLine>(`/api/v1/bank/lines/${line.id}`, post(body));
      if ("ignore" in body) setNote({ text: t("bank.ignored") });
      else {
        const inv = await ctx.call<Invoice>(`/api/v1/invoices/${body.invoice}`);
        setNote({
          text:
            inv.balance > 0
              ? t("bank.matchedLeft", { number: r.invoice?.number ?? "", left: money(inv.balance, inv.currency, locale) })
              : t("bank.matchedFull", { number: r.invoice?.number ?? "" }),
        });
      }
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    } finally {
      setBusy(false);
      setMatching(null);
    }
  };

  if (!ctx.settings.bank.length)
    return (
      <>
        <PageHeader title={t("bank.title")} description={t("bank.description")} />
        <Callout tone="info" title={t("bank.noAccounts")} className="mb-2.5">
          {t("bank.noAccountsDetail")}
        </Callout>
        <Panel title="invoices.yaml">
          <Code label="invoices.yaml">{`bank:
  garanti:
    name: Garanti TL
    iban: TR33 0006 1005 1978 6457 8413 26
    format: csv
    csv: { date: Tarih, amount: Tutar, description: Açıklama, reference: Dekont No, separator: ";", date_format: DD.MM.YYYY, decimal: "," }
  isbank:
    format: mt940`}</Code>
        </Panel>
      </>
    );

  return (
    <>
      <PageHeader
        title={t("bank.title")}
        description={t("bank.description")}
        actions={
          can("editor") && (
            <div className="flex items-end gap-2">
              {ctx.settings.bank.length > 1 && (
                <SelectField
                  aria-label={t("bank.account")}
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  options={ctx.settings.bank.map((a) => ({ value: a.id, label: a.name }))}
                />
              )}
              <FileButton
                label={t("bank.import")}
                accept=".csv,.txt,.sta,.940,text/csv,text/plain"
                icon={<Upload className="size-3.5" />}
                onFile={(f) => void importFile(f)}
              />
            </div>
          )
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="mb-2.5">
        <SegmentedControl
          label={t("invoices.show")}
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: t("bank.all") },
            { value: "unmatched", label: t("bank.waiting") },
          ]}
        />
      </div>
      <div className="flex flex-col gap-2.5">
        {ctx.settings.bank.map((a) => {
          const mine = (lines?.lines ?? []).filter((l) => l.account === a.id && (show === "all" || l.state === "unmatched"));
          const last = statements?.statements.find((s) => s.account === a.id);
          return (
            <Panel
              key={a.id}
              title={a.name}
              description={[
                a.iban,
                last
                  ? t("bank.lastImport", { file: last.filename ?? t("bank.aFile"), when: when(last.importedAt, locale), by: last.importedBy })
                  : t("bank.neverImported"),
              ]
                .filter(Boolean)
                .join(" · ")}
              flush
            >
              <DataTable
                label={t("bank.lines", { account: a.name })}
                rows={mine}
                getRowId={(l) => l.id}
                minWidth={820}
                loading={lines === undefined}
                empty={<p className="px-3 py-3 text-sm text-fg-muted">{show === "unmatched" ? t("bank.nothingWaiting") : t("bank.noLines")}</p>}
                columns={[
                  { id: "date", header: t("col.date"), sortValue: (l) => l.date, cell: (l) => shortDay(l.date, locale) },
                  {
                    id: "text",
                    header: t("bank.descriptionCol"),
                    cell: (l) => (
                      <span className="flex flex-col">
                        <span className="font-mono text-xs">{l.description}</span>
                        {l.reference && <span className="text-2xs text-fg-muted">{l.reference}</span>}
                      </span>
                    ),
                  },
                  {
                    id: "amount",
                    header: t("col.amount"),
                    align: "right",
                    mono: true,
                    sortValue: (l) => l.amount,
                    cell: (l) => money(l.amount, l.currency, locale),
                  },
                  {
                    id: "state",
                    header: t("col.state"),
                    cell: (l) =>
                      l.state === "unmatched" && can("editor") ? (
                        <Button
                          size="xs"
                          aria-label={t("bank.matchLine", { date: day(l.date, locale), amount: money(l.amount, l.currency, locale) })}
                          onClick={() => {
                            setPick(
                              guess(
                                l,
                                (owedList?.invoices ?? []).filter((i) => i.currency === l.currency),
                              ),
                            );
                            setMatching(l);
                          }}
                        >
                          {t("bank.match")}
                        </Button>
                      ) : l.state === "matched" && l.invoice ? (
                        <a href={`/invoices/${l.invoice.id}`}>
                          <StatusBadge tone={TONE.matched}>{t("bank.matchedTo", { number: l.invoice.number ?? "" })}</StatusBadge>
                        </a>
                      ) : (
                        <StatusBadge tone={TONE[l.state]}>{t(`bank.state.${l.state}`)}</StatusBadge>
                      ),
                  },
                ]}
              />
            </Panel>
          );
        })}
      </div>
      <Dialog
        open={!!matching}
        onOpenChange={(o) => !o && setMatching(null)}
        title={t("bank.matchTitle")}
        description={matching ? `${day(matching.date, locale)}, ${money(matching.amount, matching.currency, locale)}: ${matching.description}` : undefined}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => matching && void resolve(matching, { ignore: true })}>
              {t("bank.ignore")}
            </Button>
            <Button variant="primary" loading={busy} disabled={!pick} onClick={() => matching && void resolve(matching, { invoice: pick })}>
              {t("bank.match")}
            </Button>
          </>
        }
      >
        {owed.length ? (
          <SelectField
            label={t("bank.invoice")}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            options={owed.map((i) => ({
              value: i.id,
              label: t("bank.option", { number: i.number ?? "", customer: i.customer.name, left: money(i.balance, i.currency, locale) }),
            }))}
          />
        ) : (
          <p className="m-0 text-sm text-fg-muted">{t("bank.nothingOwed")}</p>
        )}
      </Dialog>
    </>
  );
}
