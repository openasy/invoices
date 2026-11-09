// Customers: who is invoiced, with their tax number and office, terms and currency, and whether GİB lists them as an
// e-Fatura user. Added one by one or from a CSV file.
import { Button, Callout, DataTable, Dialog, PageHeader, Panel, SearchInput, StatusBadge, TextField, useLocalePreference, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Customer, ImportResult } from "./api.ts";
import { FileButton, money, Notice, patch, post, readFile, useLoad, type Note } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

export function ImportErrors({ result, t }: { result: ImportResult | null; t: T }) {
  if (!result?.errors.length) return null;
  return (
    <Callout tone="danger" title={t("import.failed", { count: result.errors.length })} className="mb-2.5">
      <ul className="inv-list text-xs">
        {result.errors.slice(0, 20).map((e) => (
          <li key={e.row}>{t("import.row", { row: e.row, message: e.message })}</li>
        ))}
      </ul>
    </Callout>
  );
}

const FIELDS = [
  "name",
  "taxId",
  "taxOffice",
  "street",
  "district",
  "city",
  "postalCode",
  "country",
  "email",
  "phone",
  "currency",
  "paymentDays",
  "notes",
] as const;
type Form = Record<(typeof FIELDS)[number], string>;

const formOf = (c?: Customer): Form => ({
  name: c?.name ?? "",
  taxId: c?.taxId ?? "",
  taxOffice: c?.taxOffice ?? "",
  street: c?.address.street ?? "",
  district: c?.address.district ?? "",
  city: c?.address.city ?? "",
  postalCode: c?.address.postalCode ?? "",
  country: c?.address.country ?? "Türkiye",
  email: c?.email ?? "",
  phone: c?.phone ?? "",
  currency: c?.currency ?? "",
  paymentDays: c?.paymentDays === null || c?.paymentDays === undefined ? "" : String(c.paymentDays),
  notes: c?.notes ?? "",
});

function CustomerDialog({
  ctx,
  customer,
  open,
  onClose,
  onSaved,
}: {
  ctx: Ctx;
  customer?: Customer;
  open: boolean;
  onClose: () => void;
  onSaved: (c: Customer, text: string) => void;
}) {
  const t = useT();
  const { can } = useAuth();
  const [f, setF] = useState<Form>(formOf(customer));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF(formOf(customer));
      setError(null);
    }
  }, [open, customer]);
  const field = (k: keyof Form, label: string, extra: Record<string, unknown> = {}) => (
    <TextField label={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} disabled={!can("editor")} {...extra} />
  );
  const v = (s: string) => s.trim() || null;
  const save = async () => {
    setBusy(true);
    setError(null);
    const days = f.paymentDays.trim();
    const body = {
      name: f.name,
      taxId: v(f.taxId),
      taxOffice: v(f.taxOffice),
      address: { street: v(f.street), district: v(f.district), city: f.city, postalCode: v(f.postalCode), country: v(f.country) },
      email: v(f.email),
      phone: v(f.phone),
      currency: v(f.currency.toUpperCase()),
      paymentDays: days ? Number(days) : null,
      notes: v(f.notes),
    };
    try {
      const c = customer
        ? await ctx.call<Customer>(`/api/v1/customers/${customer.id}`, patch(body))
        : await ctx.call<Customer>("/api/v1/customers", post(body));
      onSaved(c, customer ? t("customers.saved", { name: c.name }) : t("customers.added", { name: c.name }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!customer) return;
    setBusy(true);
    try {
      await ctx.call(`/api/v1/customers/${customer.id}`, { method: "DELETE" });
      onSaved(customer, t("customers.removed", { name: customer.name }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={customer ? customer.name : t("customers.new")}
      description={t("customers.formDetail")}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      footer={
        <>
          {customer && can("editor") && (
            <Button type="button" variant="danger" className="mr-auto" disabled={busy} onClick={() => void remove()}>
              {t("common.delete")}
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {can("editor") && (
            <Button type="submit" variant="primary" loading={busy}>
              {t("common.save")}
            </Button>
          )}
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="inv-form2 grid gap-2">
        <div className="inv-span2">{field("name", t("customers.name"), { required: true })}</div>
        {field("taxId", t("customers.taxId"), { mono: true, hint: t("customers.taxIdHint") })}
        {field("taxOffice", t("customers.taxOffice"))}
        <div className="inv-span2">{field("street", t("customers.street"))}</div>
        {field("district", t("customers.district"), { hint: t("customers.districtHint") })}
        {field("city", t("customers.city"), { required: true })}
        {field("postalCode", t("customers.postalCode"))}
        {field("country", t("customers.country"))}
        {field("email", t("customers.email"), { type: "email" })}
        {field("phone", t("customers.phone"))}
        {field("currency", t("customers.currency"), { hint: t("customers.currencyHint", { currency: ctx.settings.currency }), maxLength: 3 })}
        {field("paymentDays", t("customers.terms"), { inputMode: "numeric", hint: t("customers.termsHint", { days: ctx.settings.paymentDays }) })}
        <div className="inv-span2">{field("notes", t("customers.notes"))}</div>
      </div>
    </Dialog>
  );
}

export function CustomersPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [list, reload] = useLoad<{ customers: Customer[] }>(ctx.call, "/api/v1/customers");
  const [note, setNote] = useState<Note>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);

  // A link from elsewhere (an invoice, the search window) opens one customer.
  const openId = new URLSearchParams(window.location.search).get("open");
  useEffect(() => {
    const c = openId && list?.customers.find((x) => x.id === openId);
    if (c) {
      setEditing(c);
      window.history.replaceState(null, "", "/customers");
    }
  }, [openId, list]);

  const check = async (c: Customer) => {
    setChecking(c.id);
    setNote(null);
    try {
      const r = await ctx.call<Customer>(`/api/v1/customers/${c.id}/check`, post());
      setNote({ text: r.eInvoice?.registered ? t("customers.isUser", { name: c.name }) : t("customers.notUser", { name: c.name }) });
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    } finally {
      setChecking(null);
    }
  };

  const importFile = async (file: File) => {
    setNote(null);
    setImported(null);
    try {
      const r = await ctx.call<ImportResult>("/api/v1/customers/import", post({ content: await readFile(file) }));
      setImported(r);
      if (!r.errors.length) setNote({ text: t("import.done", { added: r.added, updated: r.updated, file: file.name }) });
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    }
  };

  const q = query.trim().toLocaleLowerCase(locale);
  const rows = (list?.customers ?? []).filter((c) => !q || `${c.name} ${c.taxId ?? ""} ${c.email ?? ""}`.toLocaleLowerCase(locale).includes(q));
  const cols: Column<Customer>[] = [
    {
      id: "name",
      header: t("col.customer"),
      width: "26%",
      sortValue: (c) => c.name,
      cell: (c) => (
        <button type="button" onClick={() => setEditing(c)} className="flex min-w-0 flex-col text-start">
          <span className="truncate font-medium text-fg hover:underline">{c.name}</span>
          <span className="truncate text-2xs text-fg-muted">{c.email ?? t("customers.noEmail")}</span>
        </button>
      ),
    },
    {
      id: "tax",
      header: t("customers.taxNumber"),
      cell: (c) => (
        <span className="flex flex-col">
          <span className="font-mono text-xs">{c.taxId ?? <span className="text-danger-text">{t("customers.missing")}</span>}</span>
          <span className="text-2xs text-fg-muted">
            {c.taxOffice
              ? `${c.taxOffice}, ${c.address.city}`
              : c.taxId?.length === 10
                ? t("customers.officeMissing", { city: c.address.city })
                : c.address.city}
          </span>
        </span>
      ),
    },
    {
      id: "efatura",
      header: "e-Fatura",
      description: t("customers.eFaturaHelp"),
      cell: (c) =>
        !c.eInvoice ? (
          can("editor") && c.taxId ? (
            <Button size="xs" loading={checking === c.id} onClick={() => void check(c)} aria-label={t("customers.checkName", { name: c.name })}>
              {t("customers.check")}
            </Button>
          ) : (
            <span className="text-xs text-fg-muted">{t("customers.notChecked")}</span>
          )
        ) : c.eInvoice.registered ? (
          <StatusBadge tone="success">{t("customers.user")}</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">e-Arşiv</StatusBadge>
        ),
    },
    {
      id: "terms",
      header: t("customers.termsShort"),
      align: "right",
      mono: true,
      sortValue: (c) => c.paymentDays ?? ctx.settings.paymentDays,
      cell: (c) => t("customers.days", { n: c.paymentDays ?? ctx.settings.paymentDays }),
    },
    { id: "currency", header: t("customers.currency"), cell: (c) => c.currency ?? ctx.settings.currency },
    {
      id: "owed",
      header: t("col.owed"),
      align: "right",
      mono: true,
      sortValue: (c) => c.owed.find((o) => o.currency === ctx.settings.currency)?.amount ?? 0,
      cell: (c) =>
        c.owed.length ? (
          <span className="flex flex-col">
            {c.owed.map((o) => (
              <span key={o.currency} className={o.overdue ? "text-danger-text" : undefined}>
                {money(o.amount, o.currency, locale)}
              </span>
            ))}
          </span>
        ) : (
          "–"
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("customers.title")}
        description={t("customers.description")}
        actions={
          can("editor") && (
            <>
              <FileButton label={t("import.csv")} accept=".csv,text/csv" icon={<Upload className="size-3.5" />} onFile={(f) => void importFile(f)} />
              <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
                {t("customers.new")}
              </Button>
            </>
          )
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <ImportErrors result={imported} t={t} />
      <div className="mb-2.5">
        <SearchInput
          label={t("customers.search")}
          placeholder={t("customers.searchHint")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-64"
        />
      </div>
      <Panel flush footer={can("editor") ? t("customers.csvHelp") : undefined}>
        <DataTable
          label={t("customers.title")}
          columns={cols}
          rows={rows}
          getRowId={(c) => c.id}
          minWidth={860}
          loading={list === undefined}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("customers.none")}</p>}
        />
      </Panel>
      <CustomerDialog
        ctx={ctx}
        open={editing !== null}
        customer={editing && editing !== "new" ? editing : undefined}
        onClose={() => setEditing(null)}
        onSaved={(_c, text) => {
          setEditing(null);
          setNote({ text });
          reload();
        }}
      />
    </>
  );
}
