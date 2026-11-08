// The Nilvera adapter against fakeNilvera, which answers as Nilvera's published reference describes. It was never run
// against Nilvera itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NILVERA_KEY, startFakes, type Fakes } from "./fakes.ts";
import { fakeIntegrator, IntegratorError, nilvera } from "./integrator.ts";

let fakes: Fakes;
beforeAll(async () => {
  fakes = await startFakes();
});
afterAll(() => fakes.close());

const XML = (uuid: string, number: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice><cbc:ID>${number}</cbc:ID><cbc:UUID>${uuid}</cbc:UUID><cbc:Note>Ş ğ ı İ</cbc:Note></Invoice>\n`;

describe("Nilvera", () => {
  const api = () => nilvera({ url: `${fakes.base}/nilvera`, apiKey: NILVERA_KEY });

  it("looks up e-Fatura users and their live aliases", async () => {
    expect(await api().lookup("9876543210")).toEqual({ registered: true, title: "Yıldız Mimarlık Ltd. Şti.", aliases: ["urn:mail:defaultpk@yildiz.example"] });
    expect(await api().lookup("1111111111")).toEqual({ registered: false, title: null, aliases: [] });
    expect(fakes.nilvera.requests.at(-1)).toEqual({
      method: "GET",
      path: "/general/GlobalCompany/GetGlobalCustomerInfo/1111111111?globalUserType=Invoice",
      auth: `Bearer ${NILVERA_KEY}`,
    });
  });

  it("sends e-Fatura to the alias as a multipart file, and reads its status and the buyer's answer", async () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    const xml = XML(uuid, "ACM2026000000001");
    expect(await api().send({ channel: "e-fatura", uuid, number: "ACM2026000000001", xml, alias: "urn:mail:defaultpk@yildiz.example" })).toEqual({ ref: uuid });
    const got = fakes.nilvera.invoices.get(uuid)!;
    expect(got).toMatchObject({ kind: "einvoice", alias: "urn:mail:defaultpk@yildiz.example" });
    expect(got.xml).toBe(xml);
    expect(await api().status("e-fatura", uuid)).toEqual({ state: "waiting", detail: null });
    got.status = "succeed";
    expect((await api().status("e-fatura", uuid)).state).toBe("delivered");
    got.answer = "rejected";
    expect(await api().status("e-fatura", uuid)).toEqual({ state: "rejected", detail: "Miktar hatalı" });
    got.answer = "approved";
    expect((await api().status("e-fatura", uuid)).state).toBe("accepted");
    got.status = "error";
    expect(await api().status("e-fatura", uuid)).toEqual({ state: "failed", detail: "GİB hatası" });
    // Sent again after a lost answer: Nilvera says 409, which is sent.
    expect(await api().send({ channel: "e-fatura", uuid, number: "ACM2026000000001", xml, alias: "urn:mail:x" })).toEqual({ ref: null });
  });

  it("sends e-Arşiv, and cancels it", async () => {
    const uuid = "66666666-2222-4333-8444-555555555555";
    await api().send({ channel: "e-arsiv", uuid, number: "ACA2026000000001", xml: XML(uuid, "ACA2026000000001"), alias: null });
    expect(fakes.nilvera.requests.at(-1)?.path).toBe("/earchive/Send/Xml");
    fakes.nilvera.invoices.get(uuid)!.status = "succeed";
    expect((await api().status("e-arsiv", uuid)).state).toBe("delivered");
    await api().cancel(uuid);
    expect((await api().status("e-arsiv", uuid)).state).toBe("cancelled");
  });

  it("tells a refusal from a failure worth trying again", async () => {
    fakes.nilvera.refuseNext = { status: 422, body: { Errors: [{ Code: 1000, Description: "Fatura numarası daha önce kullanılmış" }] } };
    const e = await api()
      .send({ channel: "e-arsiv", uuid: "77777777-2222-4333-8444-555555555555", number: "ACA2026000000002", xml: "<x/>", alias: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IntegratorError);
    expect((e as IntegratorError).permanent).toBe(true);
    expect((e as Error).message).toBe("Nilvera answered 422: Fatura numarası daha önce kullanılmış");
    fakes.nilvera.refuseNext = { status: 503, body: { Message: "Bakımda" } };
    const t = (await api()
      .send({ channel: "e-arsiv", uuid: "88888888-2222-4333-8444-555555555555", number: "ACA2026000000002", xml: "<x/>", alias: null })
      .catch((x: unknown) => x)) as IntegratorError;
    expect(t.permanent).toBe(false);
    const wrongKey = await nilvera({ url: `${fakes.base}/nilvera`, apiKey: "nope" })
      .lookup("1")
      .catch((x: unknown) => x);
    expect((wrongKey as IntegratorError).permanent).toBe(true);
    const noKey = await nilvera({ url: `${fakes.base}/nilvera`, apiKey: undefined })
      .lookup("1")
      .catch((x: unknown) => x);
    expect((noKey as Error).message).toMatch(/API key is not set/);
    const down = (await nilvera({ url: "http://127.0.0.1:1", apiKey: "k" })
      .lookup("1")
      .catch((x: unknown) => x)) as IntegratorError;
    expect(down.permanent).toBe(false);
  });
});

describe("the fake integrator", () => {
  it("refuses XML that fails the checks, as an integrator would", async () => {
    const f = fakeIntegrator();
    const e = (await f
      .send({ channel: "e-arsiv", uuid: "u", number: "ACA2026000000001", xml: "<Invoice/>", alias: null })
      .catch((x: unknown) => x)) as IntegratorError;
    expect(e.permanent).toBe(true);
    expect(e.message).toMatch(/refused the XML/);
  });
});
