// Fakes of the services Invoices talks to, on one local HTTP server: Nilvera's API (as its reference describes it),
// TCMB's bulletins and CRM's deals. They answer as the real ones are documented to, and keep what they were sent.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const NILVERA_KEY = "nilvera-test-key";
export const CRM_TOKEN = "crm-test-token";

/** A TCMB bulletin as /kurlar/YYYYMM/DDMMYYYY.xml has it. */
export function bulletinXml(day: string, rates: Record<string, { unit?: number; buying: string; selling: string }>) {
  const [y, m, d] = day.split("-");
  const cur = Object.entries(rates)
    .map(
      ([code, r]) =>
        `<Currency CrossOrder="0" Kod="${code}" CurrencyCode="${code}"><Unit>${r.unit ?? 1}</Unit><Isim>${code}</Isim><CurrencyName>${code}</CurrencyName><ForexBuying>${r.buying}</ForexBuying><ForexSelling>${r.selling}</ForexSelling><BanknoteBuying>${r.buying}</BanknoteBuying><BanknoteSelling>${r.selling}</BanknoteSelling><CrossRateUSD/><CrossRateOther/></Currency>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="isokur.xsl"?>\n<Tarih_Date Tarih="${d}.${m}.${y}" Date="${m}/${d}/${y}" Bulten_No="2026/210">${cur}</Tarih_Date>`;
}

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}

export interface NilveraInvoice {
  kind: "einvoice" | "earchive";
  uuid: string;
  number: string;
  alias: string | null;
  xml: string;
  status: "waiting" | "succeed" | "error";
  answer: "unknown" | "waitingForApproval" | "approved" | "rejected";
  cancelled: boolean;
}

export async function startFakes() {
  const nilvera = {
    users: new Map<string, string[]>([["9876543210", ["urn:mail:defaultpk@yildiz.example"]]]),
    invoices: new Map<string, NilveraInvoice>(),
    /** The next send answers this status and body. */
    refuseNext: null as null | { status: number; body: unknown },
    requests: [] as Array<{ method: string; path: string; auth: string | undefined }>,
  };
  const tcmb = { bulletins: new Map<string, string>(), requests: [] as string[] };
  const crm = { deals: new Map<string, unknown>(), requests: [] as string[] };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const send = (status: number, body: unknown) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": typeof body === "string" ? "application/xml" : "application/json" }).end(text);
    };

    if (p.startsWith("/tcmb/")) {
      tcmb.requests.push(p);
      const m = /^\/tcmb\/(\d{4})(\d{2})\/(\d{2})(\d{2})(\d{4})\.xml$/.exec(p);
      const xml = m && tcmb.bulletins.get(`${m[5]}-${m[4]}-${m[3]}`);
      if (!xml) return send(404, "<html>Not found</html>");
      return send(200, xml);
    }

    if (p.startsWith("/crm/")) {
      crm.requests.push(p + url.search);
      if (req.headers.authorization !== `Bearer ${CRM_TOKEN}`) return send(401, { code: "invalid-token" });
      if (p === "/crm/api/v1/deals") {
        const status = url.searchParams.get("status");
        const deals = [...crm.deals.values()].filter((d) => (d as { status: string }).status === status);
        return send(200, { deals });
      }
      const m = /^\/crm\/api\/v1\/deals\/([^/]+)$/.exec(p);
      const d = m && crm.deals.get(decodeURIComponent(m[1]!));
      return d ? send(200, d) : send(404, { code: "not-found" });
    }

    if (p.startsWith("/nilvera/")) {
      const path = p.slice("/nilvera".length);
      nilvera.requests.push({ method: req.method ?? "GET", path: path + url.search, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${NILVERA_KEY}`) return send(403, { Message: "Yetkisiz Erişim" });
      const info = /^\/general\/GlobalCompany\/GetGlobalCustomerInfo\/(\d+)$/.exec(path);
      if (info && req.method === "GET") {
        const aliases = nilvera.users.get(info[1]!);
        if (!aliases) return send(404, { Message: "Kayıt bulunamadı" });
        return send(200, {
          TaxNumber: info[1],
          Title: "Yıldız Mimarlık Ltd. Şti.",
          Aliases: [
            ...aliases.map((Name) => ({ Name, CreationTime: "2020-01-01T00:00:00", DeletionTime: null })),
            { Name: "urn:mail:old@x", DeletionTime: "2021-01-01T00:00:00" },
          ],
        });
      }
      const sendPath = /^\/(einvoice|earchive)\/Send\/Xml$/.exec(path);
      if (sendPath && req.method === "POST") {
        const raw = await bodyOf(req);
        const type = req.headers["content-type"] ?? "";
        const boundary = /boundary=(.+)$/.exec(type)?.[1];
        if (!boundary) return send(400, { Message: "multipart/form-data bekleniyor" });
        const text = raw.toString("utf8");
        const part = text.split(`--${boundary}`).find((x) => /name="file"/.test(x));
        const xml = part?.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "") ?? "";
        if (nilvera.refuseNext) {
          const r = nilvera.refuseNext;
          nilvera.refuseNext = null;
          return send(r.status, r.body);
        }
        const uuid = /<cbc:UUID>([^<]+)<\/cbc:UUID>/.exec(xml)?.[1];
        const number = /<cbc:ID>([A-Z0-9]{16})<\/cbc:ID>/.exec(xml)?.[1];
        if (!uuid || !number) return send(422, { Errors: [{ Code: 1, Description: "UUID veya fatura numarası yok" }] });
        if (nilvera.invoices.has(uuid)) return send(409, { Message: "Daha önce gönderildi" });
        const alias = url.searchParams.get("Alias");
        if (sendPath[1] === "einvoice" && !alias) return send(422, { Errors: [{ Code: 2, Description: "Alıcı etiketi yok" }] });
        nilvera.invoices.set(uuid, {
          kind: sendPath[1] as "einvoice" | "earchive",
          uuid,
          number,
          alias,
          xml,
          status: "waiting",
          answer: "unknown",
          cancelled: false,
        });
        return send(200, { UUID: uuid, InvoiceNumber: number });
      }
      const st = /^\/einvoice\/Sale\/([^/]+)\/Status$/.exec(path);
      if (st && req.method === "GET") {
        const i = nilvera.invoices.get(st[1]!);
        if (!i) return send(404, { Message: "Kayıt bulunamadı" });
        return send(200, {
          InvoiceProfile: "TEMELFATURA",
          IssueDate: "2026-11-02T00:00:00",
          Answer: { AnswerCode: i.answer, AnswerNote: i.answer === "rejected" ? "Miktar hatalı" : null, Description: null },
          InvoiceStatus: { Code: i.status, Description: i.status === "error" ? "GİB hatası" : null, DetailDescription: null },
          EnvelopeInfo: { UUID: null, GIBCode: i.status === "succeed" ? 1300 : 0, GIBDescription: null, CreatedDate: "2026-11-02T00:00:00" },
        });
      }
      const ast = /^\/earchive\/Invoices\/([^/]+)\/Status$/.exec(path);
      if (ast && req.method === "GET") {
        const i = nilvera.invoices.get(ast[1]!);
        if (!i) return send(404, { Message: "Kayıt bulunamadı" });
        return send(200, { StatusDetail: null, StatusCode: i.status, ReportStatus: "NotReported", CancelStatus: i.cancelled });
      }
      const cancel = /^\/earchive\/Invoices\/([^/]+)\/Cancel$/.exec(path);
      if (cancel && req.method === "PUT") {
        const i = nilvera.invoices.get(cancel[1]!);
        if (!i) return send(404, { Message: "Kayıt bulunamadı" });
        i.cancelled = true;
        return send(200, ["Fatura iptal edildi"]);
      }
      return send(404, { Message: "Yok" });
    }
    send(404, { error: "unknown fake" });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    nilvera,
    tcmb,
    crm,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type Fakes = Awaited<ReturnType<typeof startFakes>>;
