// The GİB special integrator (özel entegratör), behind one interface. Invoices writes and checks the UBL-TR XML; the
// integrator signs it with its financial seal, sends e-Fatura to the buyer's mailbox through GİB and reports e-Arşiv
// to GİB, and answers how each one is doing. Invoices is not an integrator itself, and only integrators with an API
// can be connected.
//
// - nilvera: Nilvera's REST API (developer.nilvera.com), Bearer API key:
//     GET  /general/GlobalCompany/GetGlobalCustomerInfo/{TaxNumber}?globalUserType=Invoice   the buyer's e-Fatura aliases
//     POST /einvoice/Send/Xml?Alias=<alias>   multipart `file`: the UBL-TR XML   -> { UUID, InvoiceNumber }
//     POST /earchive/Send/Xml                 multipart `file`                   -> { UUID, InvoiceNumber }
//     GET  /einvoice/Sale/{UUID}/Status       InvoiceStatus.Code, Answer.AnswerCode
//     GET  /earchive/Invoices/{UUID}/Status   StatusCode, CancelStatus
//     PUT  /earchive/Invoices/{UUID}/Cancel
//   Written from Nilvera's published reference and tested only against fakeNilvera in fakes.ts, never against Nilvera.
// - fake: everything stays in this process and nothing reaches GİB; for trying Invoices and for the tests.
import { validateUbl } from "./ubl.ts";

export type Channel = "e-fatura" | "e-arsiv";

/** Where an invoice is once the integrator has it. */
export type DeliveryState = "waiting" | "delivered" | "accepted" | "rejected" | "failed" | "cancelled";

export class IntegratorError extends Error {
  /** true when sending the same again gives the same answer: the integrator refused the invoice or the key. */
  readonly permanent: boolean;
  readonly status: number | null;
  constructor(message: string, status: number | null = null, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

export interface UserInfo {
  /** Registered for e-Fatura: invoices to it go as e-Fatura to one of its aliases; otherwise as e-Arşiv. */
  registered: boolean;
  title: string | null;
  /** The mailboxes (posta kutusu etiketleri) invoices are sent to, such as urn:mail:defaultpk@example.com.tr. */
  aliases: string[];
}

export interface IntegratorApi {
  provider: string;
  lookup(taxId: string): Promise<UserInfo>;
  send(x: { channel: Channel; uuid: string; number: string; xml: string; alias: string | null }): Promise<{ ref: string | null }>;
  status(channel: Channel, uuid: string): Promise<{ state: DeliveryState; detail: string | null }>;
  /** Cancels an e-Arşiv invoice (e-Fatura cannot be cancelled; a credit note corrects it). */
  cancel(uuid: string): Promise<void>;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The message in an error body, however the integrator writes it. */
function messageOf(body: string): string | null {
  try {
    const j = JSON.parse(body) as unknown;
    const o = obj(j);
    if (Array.isArray(j)) return j.map((x) => str(x) ?? str(obj(x)?.Description) ?? JSON.stringify(x)).join("; ");
    const errors = Array.isArray(o?.Errors) ? (o!.Errors as unknown[]).map((e) => str(obj(e)?.Description) ?? str(e)).filter(Boolean) : [];
    return errors.length ? errors.join("; ") : (str(o?.Message) ?? str(o?.message) ?? str(o?.detail) ?? str(o?.title) ?? null);
  } catch {
    return body.trim().slice(0, 300) || null;
  }
}

export function nilvera(o: { url: string; apiKey: string | undefined; fetch?: typeof fetch }): IntegratorApi {
  const f = o.fetch ?? fetch;
  async function call(method: string, path: string, init: { body?: FormData; ok404?: boolean } = {}): Promise<{ status: number; body: unknown }> {
    if (!o.apiKey) throw new IntegratorError("The integrator's API key is not set.", null, true);
    let res: Response;
    try {
      res = await f(`${o.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${o.apiKey}`, accept: "application/json" },
        body: init.body,
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch (err) {
      throw new IntegratorError(`Nilvera could not be reached: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 404 && init.ok404) return { status: 404, body: null };
    if (!res.ok && res.status !== 409) {
      const detail = messageOf(text);
      // 400, 403 and 422 are the request's fault: sending it again gives the same answer.
      const permanent = [400, 401, 403, 404, 422].includes(res.status);
      throw new IntegratorError(`Nilvera answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, permanent);
    }
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }
  return {
    provider: "nilvera",
    async lookup(taxId) {
      const r = await call("GET", `/general/GlobalCompany/GetGlobalCustomerInfo/${encodeURIComponent(taxId)}?globalUserType=Invoice`, { ok404: true });
      if (r.status === 404) return { registered: false, title: null, aliases: [] };
      const b = obj(r.body);
      const aliases = (Array.isArray(b?.Aliases) ? (b!.Aliases as unknown[]) : [])
        .map(obj)
        .filter((a) => a && !a.DeletionTime)
        .map((a) => str(a!.Name))
        .filter((a): a is string => !!a);
      return { registered: aliases.length > 0, title: str(b?.Title), aliases };
    },
    async send({ channel, number, xml, alias }) {
      const form = new FormData();
      form.append("file", new Blob([xml], { type: "application/xml" }), `${number}.xml`);
      const path = channel === "e-fatura" ? `/einvoice/Send/Xml?${new URLSearchParams({ Alias: alias ?? "" })}` : "/earchive/Send/Xml";
      // 409: Nilvera has this invoice already, from an earlier try whose answer was lost. It is sent.
      const r = await call("POST", path, { body: form });
      return { ref: str(obj(r.body)?.UUID) };
    },
    async status(channel, uuid) {
      if (channel === "e-fatura") {
        const b = obj((await call("GET", `/einvoice/Sale/${encodeURIComponent(uuid)}/Status`)).body);
        const st = obj(b?.InvoiceStatus);
        const answer = obj(b?.Answer);
        const detail = str(st?.DetailDescription) ?? str(st?.Description) ?? str(obj(b?.EnvelopeInfo)?.GIBDescription);
        if (st?.Code === "error") return { state: "failed", detail };
        if (st?.Code !== "succeed") return { state: "waiting", detail };
        if (answer?.AnswerCode === "approved" || answer?.AnswerCode === "documentAnsweredAutomatically")
          return { state: "accepted", detail: str(answer.AnswerNote) };
        if (answer?.AnswerCode === "rejected") return { state: "rejected", detail: str(answer.AnswerNote) ?? str(answer.Description) };
        return { state: "delivered", detail };
      }
      const b = obj((await call("GET", `/earchive/Invoices/${encodeURIComponent(uuid)}/Status`)).body);
      const detail = str(b?.StatusDetail);
      if (b?.CancelStatus === true) return { state: "cancelled", detail };
      if (b?.StatusCode === "error") return { state: "failed", detail };
      if (b?.StatusCode === "succeed") return { state: "delivered", detail };
      return { state: "waiting", detail };
    },
    async cancel(uuid) {
      await call("PUT", `/earchive/Invoices/${encodeURIComponent(uuid)}/Cancel`);
    },
  };
}

/**
 * An integrator in this process. Tax numbers (10 digits) are e-Fatura users with the alias
 * urn:mail:defaultpk@<vkn>.example, identity numbers are not. It checks each XML as Invoices does, so what it
 * refuses an integrator would refuse too; it answers waiting once, then delivered. answer() plays the buyer of a
 * TICARIFATURA, and failNext makes the next send fail.
 */
export function fakeIntegrator() {
  const sent = new Map<
    string,
    { channel: Channel; number: string; xml: string; alias: string | null; polls: number; state: DeliveryState; detail: string | null }
  >();
  const fake = {
    provider: "fake",
    sent,
    failNext: null as null | IntegratorError,
    registered: new Set<string>(),
    async lookup(taxId: string): Promise<UserInfo> {
      const registered = taxId.length === 10 || fake.registered.has(taxId);
      return { registered, title: null, aliases: registered ? [`urn:mail:defaultpk@${taxId}.example`] : [] };
    },
    async send(x: { channel: Channel; uuid: string; number: string; xml: string; alias: string | null }) {
      if (fake.failNext) {
        const e = fake.failNext;
        fake.failNext = null;
        throw e;
      }
      const problems = validateUbl(x.xml);
      if (problems.length) throw new IntegratorError(`The integrator refused the XML: ${problems.join(" ")}`, 422, true);
      if (x.channel === "e-fatura" && !x.alias) throw new IntegratorError("An e-Fatura needs the buyer's alias.", 422, true);
      if ([...sent.values()].some((s) => s.number === x.number && s.state !== "failed" && !sent.has(x.uuid)))
        throw new IntegratorError(`${x.number} was sent before with another ETTN.`, 422, true);
      sent.set(x.uuid, { ...x, polls: 0, state: "waiting", detail: null });
      return { ref: x.uuid };
    },
    async status(_channel: Channel, uuid: string) {
      const s = sent.get(uuid);
      if (!s) throw new IntegratorError("No invoice with this ETTN.", 404, true);
      if (s.state === "waiting" && ++s.polls > 1) s.state = "delivered";
      return { state: s.state, detail: s.detail };
    },
    async cancel(uuid: string) {
      const s = sent.get(uuid);
      if (!s) throw new IntegratorError("No invoice with this ETTN.", 404, true);
      if (s.channel !== "e-arsiv") throw new IntegratorError("Only an e-Arşiv invoice can be cancelled.", 422, true);
      s.state = "cancelled";
    },
    /** The buyer's answer to a TICARIFATURA, or GİB's error on an envelope. */
    answer(uuid: string, state: DeliveryState, detail: string | null = null) {
      const s = sent.get(uuid);
      if (s) Object.assign(s, { state, detail });
    },
  };
  return fake;
}
export type FakeIntegrator = ReturnType<typeof fakeIntegrator>;
