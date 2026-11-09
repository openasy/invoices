// Integrations (the GİB integrator, TCMB, mail, CRM, the bank accounts and what other products call) and the read-only
// settings file.
import { Button, Callout, PageHeader, Panel, StatusBadge, TextField, navigate, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { useState, type ReactNode } from "react";
import type { Ctx } from "./App.tsx";
import type { InvoiceDetail } from "./api.ts";
import { Code, Notice, post, when, type Note } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";

function LinkPanel({
  title,
  detail,
  ok,
  state,
  example,
  children,
}: {
  title: string;
  detail: string;
  ok: boolean | null;
  state: string;
  example: string;
  children?: ReactNode;
}) {
  return (
    <Panel title={title} description={detail} actions={<StatusBadge tone={ok === null ? "neutral" : ok ? "success" : "warning"}>{state}</StatusBadge>}>
      {ok === null ? <Code label={title}>{example}</Code> : <div className="flex flex-col gap-1 text-xs text-fg-muted">{children}</div>}
    </Panel>
  );
}

function DealDraft({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [deal, setDeal] = useState("");
  const [note, setNote] = useState<Note>(null);
  return (
    <form
      className="mt-2 flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        setNote(null);
        void ctx.call<InvoiceDetail>(`/api/v1/crm/deals/${encodeURIComponent(deal.trim())}`, post()).then(
          (inv) => {
            ctx.onChanged();
            navigate(`/invoices/${inv.id}`);
          },
          (err: Error) => setNote({ text: err.message, tone: "danger" }),
        );
      }}
    >
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="flex items-end gap-1.5">
        <TextField label={t("integrations.dealId")} mono value={deal} onChange={(e) => setDeal(e.target.value)} hint={t("integrations.dealHint")} />
        <Button type="submit" size="sm" disabled={!deal.trim()}>
          {t("integrations.draftDeal")}
        </Button>
      </div>
    </form>
  );
}

export function IntegrationsPage(ctx: Ctx) {
  const t = useT();
  const { can } = useAuth();
  const s = ctx.settings;
  const origin = window.location.origin;
  const i = s.integrator;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="inv-halves grid gap-2.5">
        <LinkPanel
          title={t("integrations.integrator")}
          detail={t("integrations.integratorDetail")}
          ok={i ? i.keySet : null}
          state={
            !i ? t("integrations.notSet") : i.keySet ? (i.provider === "fake" ? t("integrations.fake") : t("integrations.set")) : t("integrations.keyMissing")
          }
          example={`integrator:
  provider: nilvera
  url: https://apitest.nilvera.com
  api_key: INVOICES_INTEGRATOR_KEY
  profile: TEMELFATURA
  poll_every: 5m`}
        >
          {i && (
            <>
              <span className="text-fg">{i.provider === "nilvera" ? "Nilvera" : t("integrations.fake")}</span>
              <span className="font-mono">{i.url}</span>
              <span>{t("integrations.profile", { profile: i.profile })}</span>
              {i.provider === "fake" && <span className="text-warning-text">{t("integrations.fakeDetail")}</span>}
              {!i.keySet && <span className="text-danger-text">{t("integrations.keyMissingDetail")}</span>}
              {!s.sellerSet && <span className="text-danger-text">{t("integrations.noSeller")}</span>}
            </>
          )}
        </LinkPanel>
        <LinkPanel title="TCMB" detail={t("integrations.tcmb")} ok state={t("integrations.set")} example="">
          <span className="font-mono">{s.exchangeRates.url}</span>
          <span>{t(`rate.${s.exchangeRates.rate}`)}</span>
        </LinkPanel>
        <LinkPanel
          title={t("integrations.mail")}
          detail={t("integrations.mailDetail")}
          ok={s.mail ? true : null}
          state={s.mail ? t("integrations.set") : t("integrations.notSet")}
          example={`mail:
  host: smtp.example.com
  port: 587
  security: starttls
  user: fatura@example.com
  password: INVOICES_MAIL_PASSWORD
  from: Acme Fatura <fatura@example.com>`}
        >
          {s.mail && (
            <>
              <span className="font-mono">
                {s.mail.host}:{s.mail.port}
              </span>
              <span>{s.mail.from}</span>
              <span>{s.emailOnIssue ? t("integrations.emailOnIssue") : t("integrations.noEmailOnIssue")}</span>
            </>
          )}
        </LinkPanel>
        <LinkPanel
          title="CRM"
          detail={t("integrations.crm")}
          ok={s.crm ? true : null}
          state={s.crm ? t("integrations.set") : t("integrations.notSet")}
          example={`crm:
  url: http://crm:8080
  token: INVOICES_CRM_TOKEN
  won_deals: draft
  check_every: 5m`}
        >
          {s.crm && (
            <>
              <span className="font-mono">{s.crm.url}</span>
              <span>{s.crm.wonDeals === "draft" ? t("integrations.wonDraft") : t("integrations.wonOff")}</span>
              {can("editor") && <DealDraft ctx={ctx} />}
            </>
          )}
        </LinkPanel>
        <LinkPanel
          title={t("integrations.bank")}
          detail={t("integrations.bankDetail")}
          ok={s.bank.length ? true : null}
          state={s.bank.length ? t("integrations.accounts", { count: s.bank.length }) : t("integrations.notSet")}
          example={`bank:
  garanti:
    name: Garanti TL
    format: csv
    csv: { date: Tarih, amount: Tutar, description: Açıklama }`}
        >
          {s.bank.map((a) => (
            <span key={a.id}>
              <span className="text-fg">{a.name}</span> · {a.format.toUpperCase()} · {a.currency}
              {a.iban && <span className="font-mono"> · {a.iban}</span>}
            </span>
          ))}
          <a href="/bank" className="mt-1">
            {t("integrations.toBank")}
          </a>
        </LinkPanel>
        <Panel title={t("integrations.time")} description={t("integrations.timeDetail")}>
          <p className="mb-1.5 text-xs text-fg-muted">{t("integrations.billable", { count: ctx.summary?.openBillableItems ?? 0 })}</p>
          <Code label={t("integrations.time")}>{`POST ${origin}/api/v1/billable-items
Authorization: Bearer <an Invoices token with the editor role>

{ "items": [{ "external_id": "time-2026-11-1", "customer": { "taxId": "9870412235" },
  "date": "2026-11-02", "description": "Consulting, October", "quantity": 40,
  "unit": "HUR", "unitPrice": 240000, "kdvRate": 20 }] }`}</Code>
        </Panel>
        <Panel title={t("integrations.helpdesk")} description={t("integrations.helpdeskDetail")}>
          <Code label={t("integrations.helpdesk")}>{`GET ${origin}/api/v1/lookup?email=muhasebe@example.com
GET ${origin}/api/v1/lookup?number=ACM2026000000409`}</Code>
        </Panel>
        <Panel title={t("integrations.inventory")} description={t("integrations.inventoryDetail")}>
          <Code label={t("integrations.inventory")}>{`GET ${origin}/api/v1/stock-movements?after=0`}</Code>
        </Panel>
        <Panel title={t("integrations.erasure")} description={t("integrations.erasureDetail")}>
          <Code label={t("integrations.erasure")}>{`POST ${origin}/api/v1/erasures
Authorization: Bearer <an Invoices token with the admin role>

{ "reference": "KVKK-2026-099", "people": { "emails": ["…"] } }
202 { "status": "waiting", "detail": "1 invoice is not yet paid." }`}</Code>
          <a href="/api/docs/" className="mt-2 block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
      </div>
    </>
  );
}

export function SettingsFilePage({ settings: s }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const f = s.file;
  const applied = f?.appliedAt ? when(f.appliedAt, locale) : t("settings.notYet");
  const a = s.seller.address;
  const days = (xs: number[]) => xs.join(", ") || t("settings.none");
  return (
    <FileSettingsPage
      file="invoices.yaml"
      applied={applied}
      yaml={s.text || t("settings.noFile")}
      problems={
        <>
          {f?.error && (
            <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
              {f.error}
            </Callout>
          )}
          {!!f?.warnings.length && (
            <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
              <ul className="inv-list">
                {f.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      }
      groups={[
        {
          title: t("settings.seller"),
          description: t("settings.sellerDetail"),
          items: [
            {
              label: t("customers.name"),
              value: s.sellerSet ? s.seller.name : <span className="text-danger-text">{t("settings.sellerUnset")}</span>,
              path: "seller.name",
            },
            { label: t("settings.vkn"), value: [s.seller.taxId, s.seller.taxOffice].filter(Boolean).join(", "), path: "seller.tax_id" },
            { label: t("settings.address"), value: [a?.street, a?.district, a?.city].filter(Boolean).join(", ") || t("settings.none"), path: "seller.address" },
            { label: "IBAN", value: s.seller.iban ? <span className="font-mono">{s.seller.iban}</span> : t("settings.none"), path: "seller.iban" },
          ],
        },
        {
          title: t("settings.numbers"),
          items: [
            { label: t("settings.series"), value: t("settings.seriesValue", { eFatura: s.series.eFatura, eArsiv: s.series.eArsiv }), path: "series" },
            {
              label: t("integrations.integrator"),
              value: s.integrator
                ? `${s.integrator.provider === "nilvera" ? "Nilvera" : t("integrations.fake")}, ${s.integrator.profile}`
                : t("integrations.notSet"),
              path: "integrator",
            },
            { label: t("settings.rates"), value: t(`rate.${s.exchangeRates.rate}`), path: "exchange_rates.rate" },
            { label: t("settings.currency"), value: `${s.currency}, ${s.timeZone}, ${s.language}`, path: "currency" },
          ],
        },
        {
          title: t("settings.taxes"),
          items: [
            { label: t("settings.kdvRates"), value: s.kdvRates.map((r) => `${r}%`).join(", "), path: "kdv_rates" },
            { label: t("settings.withholding"), value: s.withholding.map((w) => `${w.code} ${w.share}`).join(", "), path: "withholding" },
            { label: t("settings.exemptions"), value: s.exemptions.map((x) => x.code).join(", "), path: "exemptions" },
          ],
        },
        {
          title: t("settings.collecting"),
          items: [
            { label: t("settings.terms"), value: t("settings.termsValue", { days: s.paymentDays }), path: "payment_terms" },
            {
              label: t("settings.reminders"),
              value: t("settings.remindersValue", { before: days(s.reminders.before), after: days(s.reminders.after), at: s.reminders.at }),
              path: "reminders",
            },
            { label: t("settings.emailOnIssue"), value: s.emailOnIssue ? t("settings.yes") : t("settings.no"), path: "email_on_issue" },
            { label: t("integrations.bank"), value: s.bank.map((b) => `${b.name} (${b.format.toUpperCase()})`).join(", ") || t("settings.none"), path: "bank" },
            {
              label: "CRM",
              value: s.crm ? (s.crm.wonDeals === "draft" ? t("integrations.wonDraft") : t("integrations.wonOff")) : t("settings.none"),
              path: "crm.won_deals",
            },
          ],
        },
      ]}
    />
  );
}
