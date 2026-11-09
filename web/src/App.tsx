import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  Building2,
  FileDown,
  FileText,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LogIn,
  LogOut,
  Package,
  Plug,
  Repeat,
  Settings as SettingsIcon,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Customer, Invoice, ProductLink, Settings, Summary } from "./api.ts";
import { BankPage } from "./bank.tsx";
import { channelName, useApi, type Call } from "./common.tsx";
import { CustomersPage } from "./customers.tsx";
import { InvoiceEditor } from "./editor.tsx";
import { ExportsPage } from "./exports.tsx";
import { useT, setViewerLocale } from "./i18n.ts";
import { InvoicePage } from "./invoice.tsx";
import { InvoicesPage } from "./invoices.tsx";
import { OverviewPage } from "./overview.tsx";
import { IntegrationsPage, SettingsFilePage } from "./pages.tsx";
import { ProductsPage } from "./products.tsx";
import { RecurringPage } from "./recurring.tsx";

const PAGES = [
  "overview",
  "invoices",
  "customers",
  "products",
  "recurring",
  "bank",
  "exports",
  "integrations",
  "settings",
  "account",
  "members",
  "signin",
  "tokens",
] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "new" } | { page: "invoice"; id: string; edit: boolean };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
function parseRoute(path: string): Route {
  const [page, id, sub] = path.replace(/^\//, "").split("/");
  if (page === "invoices" && id === "new") return { page: "new" };
  if (page === "invoices" && id) return { page: "invoice", id: decodeURIComponent(id), edit: sub === "edit" };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "overview" };
}

export interface Ctx {
  call: Call;
  settings: Settings;
  summary: Summary | undefined;
  onChanged: () => void;
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [settings, setSettings] = useState<Settings>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "invoices" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds invoices by number or customer, and customers by name or tax number.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const [inv, cus] = await Promise.all([
        call<{ invoices: Invoice[] }>(`/api/v1/invoices?${new URLSearchParams({ q })}`, { signal }),
        call<{ customers: Customer[] }>(`/api/v1/customers?${new URLSearchParams({ q })}`, { signal }),
      ]);
      return [
        ...inv.invoices.slice(0, 6).map((i) => ({
          id: `invoice:${i.id}`,
          label: i.number ?? msg("invoice.draft"),
          detail: `${i.customer.name}${i.channel ? `, ${channelName(i.channel)}` : ""}`,
          kind: msg(i.kind === "credit_note" ? "search.creditNote" : "search.invoice"),
          icon: FileText,
          href: `/invoices/${i.id}`,
        })),
        ...cus.customers.slice(0, 4).map((c) => ({
          id: `customer:${c.id}`,
          label: c.name,
          detail: c.taxId ?? undefined,
          kind: msg("search.customer"),
          icon: Building2,
          href: `/customers?open=${c.id}`,
        })),
      ];
    },
    [call, msg],
  );

  const needsYou = summary ? summary.drafts + summary.refused : 0;
  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "invoices", label: msg("nav.invoices"), icon: FileText, count: needsYou || undefined },
    { id: "customers", label: msg("nav.customers"), icon: Building2 },
    { id: "products", label: msg("nav.products"), icon: Package },
    { id: "recurring", label: msg("nav.recurring"), icon: Repeat },
    { id: "bank", label: msg("nav.bank"), icon: Landmark, count: summary?.unmatchedBankLines || undefined },
    { id: "exports", label: msg("nav.exports"), icon: FileDown },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "invoice" || route.page === "new" ? "invoices" : route.page;
  const roleName = msg(`roles.${(["owner", "admin", "editor", "viewer"].includes(me.user.role) ? me.user.role : "viewer") as "viewer"}`);
  const ctx = settings && { call, settings, summary, onChanged: reload };

  return (
    <AppShell
      product="invoices"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {settings.file.error}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : !ctx ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "invoices" ? (
        <InvoicesPage {...ctx} />
      ) : route.page === "new" ? (
        <InvoiceEditor key="new" {...ctx} id={null} />
      ) : route.page === "invoice" ? (
        <InvoicePage key={`${route.id}:${route.edit}`} {...ctx} id={route.id} edit={route.edit} />
      ) : route.page === "customers" ? (
        <CustomersPage {...ctx} />
      ) : route.page === "products" ? (
        <ProductsPage {...ctx} />
      ) : route.page === "recurring" ? (
        <RecurringPage {...ctx} />
      ) : route.page === "bank" ? (
        <BankPage {...ctx} />
      ) : route.page === "exports" ? (
        <ExportsPage {...ctx} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage {...ctx} />
      ) : route.page === "settings" ? (
        <SettingsFilePage {...ctx} />
      ) : (
        <OverviewPage {...ctx} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Invoices">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
