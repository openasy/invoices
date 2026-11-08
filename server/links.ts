// The other services Invoices talks to, each behind a small interface so the tests can point it at a fake:
//
// - CRM: won deals are read from GET /api/v1/deals?status=won and GET /api/v1/deals/{id} (crm/openapi.json, Deal and
//   DealDetail), with a CRM token of the viewer role. CRM sends nothing itself, so Invoices asks every few minutes.
// - Mail: invoices and reminders go out through the SMTP server in the file.
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.ts";

export class LinkError extends Error {
  readonly permanent: boolean;
  readonly status: number | null;
  constructor(message: string, status: number | null = null, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A won deal as Invoices needs it, read from CRM's DealDetail. Amounts are CRM's: in the currency's units, without KDV. */
export interface CrmDeal {
  id: string;
  name: string;
  status: string;
  value: number;
  currency: string;
  closedAt: string | null;
  company: { id: string; name: string; city: string | null; domain: string | null } | null;
  contact: { id: string; name: string; email: string | null } | null;
  /** The lines of the accepted quote, else the last one sent; null when the deal has no such quote. */
  quote: { number: string; vat: number; lines: Array<{ item: string; quantity: number; unitPrice: number; discount: number }> } | null;
}

export interface CrmLink {
  /** Won deals, as GET /api/v1/deals?status=won lists them: id and closedAt. */
  wonDeals(): Promise<Array<{ id: string; closedAt: string | null }>>;
  deal(id: string): Promise<CrmDeal | null>;
}

async function get(f: typeof fetch, url: string, token: string | undefined): Promise<{ status: number; body: unknown }> {
  if (!token) throw new LinkError("The CRM token is not set.", null, true);
  let res: Response;
  try {
    res = await f(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  } catch (err) {
    throw new LinkError(`CRM could not be reached: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok && res.status !== 404) throw new LinkError(`CRM answered ${res.status}`, res.status, res.status === 401 || res.status === 403);
  return { status: res.status, body };
}

export function crmLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): CrmLink {
  const f = o.fetch ?? fetch;
  return {
    async wonDeals() {
      const r = await get(f, `${o.url}/api/v1/deals?status=won`, o.token);
      const deals = Array.isArray(obj(r.body)?.deals) ? (obj(r.body)!.deals as unknown[]) : [];
      return deals
        .map(obj)
        .filter((d) => d && str(d.id) && d.status === "won")
        .map((d) => ({ id: str(d!.id)!, closedAt: str(d!.closedAt) }));
    },
    async deal(id) {
      const r = await get(f, `${o.url}/api/v1/deals/${encodeURIComponent(id)}`, o.token);
      const d = obj(r.body);
      if (r.status === 404 || !d || !str(d.id)) return null;
      const company = obj(d.companyDetail) ?? obj(d.company);
      const contact = obj(d.contactDetail) ?? obj(d.contact);
      const quotes = (Array.isArray(d.quotes) ? (d.quotes as unknown[]) : []).map(obj).filter((q): q is Record<string, unknown> => !!q);
      const quote = quotes.find((q) => q.state === "accepted") ?? quotes.filter((q) => q.state === "sent").at(-1) ?? null;
      return {
        id: str(d.id)!,
        name: str(d.name, 200) ?? "Deal",
        status: str(d.status) ?? "",
        value: numOf(d.value) ?? 0,
        currency: str(d.currency, 3) ?? "TRY",
        closedAt: str(d.closedAt),
        company:
          company && str(company.id)
            ? { id: str(company.id)!, name: str(company.name, 200) ?? "", city: str(company.city, 60), domain: str(company.domain) }
            : null,
        contact: contact && str(contact.id) ? { id: str(contact.id)!, name: str(contact.name, 200) ?? "", email: str(contact.email, 254) } : null,
        quote: quote
          ? {
              number: str(quote.number) ?? "",
              vat: numOf(quote.vat) ?? 20,
              lines: (Array.isArray(quote.lines) ? (quote.lines as unknown[]) : [])
                .map(obj)
                .filter((l): l is Record<string, unknown> => !!l && !!str(l.item))
                .map((l) => ({
                  item: str(l.item, 300)!,
                  quantity: numOf(l.quantity) ?? 1,
                  unitPrice: numOf(l.unitPrice) ?? 0,
                  discount: numOf(l.discount) ?? 0,
                })),
            }
          : null,
      };
    },
  };
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  close(): void;
}

export function smtpMailer(m: NonNullable<Config["mail"]>, password: string | undefined): Mailer {
  const t: Transporter = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.security === "tls",
    requireTLS: m.security === "starttls",
    ignoreTLS: m.security === "none",
    auth: m.user && password ? { user: m.user, pass: password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      await t.sendMail({ from: m.from, to: mail.to, subject: mail.subject, text: mail.text, attachments: mail.attachments });
    },
    close: () => t.close(),
  };
}
