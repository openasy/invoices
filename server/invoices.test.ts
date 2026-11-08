// Invoices end to end on the fake integrator: numbering, e-Fatura or e-Arşiv, the integrator's answers, credit notes,
// payments and reminders, recurring invoices, bank statements, CRM's won deals and the exports.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntegratorError } from "./integrator.ts";
import { DAY } from "./store.ts";
import { ECE, seedCustomers, startApp, type TestApp } from "./test-app.ts";
import { validateUbl } from "./ubl.ts";
import { parseXml, textAt } from "./xml.ts";

let app: TestApp;
beforeEach(async () => {
  app = await startApp();
});
afterEach(() => app.close());

const LINE = { name: "Mimari yazılım, aylık", quantity: 2, unitPrice: 600000, kdvRate: 20 };

async function issued(customer: string, lines: unknown[] = [LINE], extra: Record<string, unknown> = {}) {
  const d = app.invoices.createInvoice(ECE, { customer, lines, ...extra });
  return app.invoices.issue(ECE, d.id, {});
}

describe("numbering", () => {
  it("gives the next number of the series and year only when issuing, and never skips one", async () => {
    const { company, person } = seedCustomers(app);
    const a = await issued(company.id);
    const draft = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE] });
    expect(draft.number).toBeNull();
    app.invoices.removeInvoice(ECE, draft.id);
    const b = await issued(company.id);
    const c = await issued(person.id);
    expect([a.number, b.number, c.number]).toEqual(["ACM2026000000001", "ACM2026000000002", "ACA2026000000001"]);
    expect([a.channel, c.channel]).toEqual(["e-fatura", "e-arsiv"]);
    expect([a.profile, c.profile]).toEqual(["TEMELFATURA", "EARSIVFATURA"]);
    expect(a.alias).toBe("urn:mail:defaultpk@9876543210.example");
    expect(() => app.invoices.removeInvoice(ECE, a.id)).toThrow(/cannot be skipped/);
  });

  it("gives no number when the XML would be refused, so the next one is not skipped", async () => {
    const { company } = seedCustomers(app);
    // A customer without a district fails before a number is given.
    const bad = app.invoices.createCustomer(ECE, { name: "Eksik Adres A.Ş.", taxId: "5555555555", taxOffice: "Kadıköy", address: { city: "İstanbul" } });
    const d = app.invoices.createInvoice(ECE, { customer: bad.id, lines: [LINE] });
    await expect(app.invoices.issue(ECE, d.id, {})).rejects.toThrow(/district/);
    expect((await issued(company.id)).number).toBe("ACM2026000000001");
  });

  it("never dates a number before the one before it, nor in the future or more than seven days back", async () => {
    const { company } = seedCustomers(app);
    await issued(company.id);
    const d = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE] });
    await expect(app.invoices.issue(ECE, d.id, { date: "2026-11-01" })).rejects.toThrow(/later number cannot have an earlier date/);
    await expect(app.invoices.issue(ECE, d.id, { date: "2026-11-03" })).rejects.toThrow(/future/);
    await expect(app.invoices.issue(ECE, d.id, { date: "2026-10-20" })).rejects.toThrow(/seven days/);
    expect((await app.invoices.issue(ECE, d.id, {})).number).toBe("ACM2026000000002");
  });

  it("starts again at 1 each year", async () => {
    const { company } = seedCustomers(app);
    await issued(company.id);
    app.clock.set(Date.parse("2027-01-04T08:00:00Z"));
    expect((await issued(company.id)).number).toBe("ACM2027000000001");
  });

  it("gives every number once when many are issued at the same time", async () => {
    const { company } = seedCustomers(app);
    const drafts = Array.from({ length: 12 }, () => app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE] }));
    const done = await Promise.all(drafts.map((d) => app.invoices.issue(ECE, d.id, {})));
    expect(done.map((x) => x.number).sort()).toEqual(Array.from({ length: 12 }, (_x, i) => `ACM2026${String(i + 1).padStart(9, "0")}`));
  });
});

describe("issuing and the integrator", () => {
  it("freezes the invoice: the XML passes, the buyer is kept as it was, and it cannot be changed", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id);
    expect(inv.status).toBe("queued");
    const xml = app.invoices.invoiceXml(inv.id).xml;
    expect(validateUbl(xml)).toEqual([]);
    expect(textAt(parseXml(xml), "AccountingCustomerParty", "Party", "PartyName", "Name")).toBe("Yıldız Mimarlık Ltd. Şti.");
    app.invoices.updateCustomer(ECE, company.id, { name: "Yıldız Mimarlık A.Ş." });
    expect(app.invoices.getInvoice(inv.id).customer.name).toBe("Yıldız Mimarlık Ltd. Şti.");
    expect(() => app.invoices.updateInvoice(ECE, inv.id, { notes: "x" })).toThrow(/never changed/);
    expect(inv.dueDate).toBe("2026-12-02");
    expect(inv.totals).toMatchObject({ net: 1200000, kdv: 240000, total: 1440000, payable: 1440000 });
  });

  it("goes queued, waiting, delivered, and is emailed with its PDF and XML once the integrator has it", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id);
    await app.invoices.deliver();
    expect(app.invoices.getInvoice(inv.id).status).toBe("waiting");
    expect(app.mails).toHaveLength(1);
    expect(app.mails[0]).toMatchObject({ to: "muhasebe@yildiz.example", subject: "Fatura ACM2026000000001 - Acme Yazılım A.Ş." });
    expect(app.mails[0]!.attachments!.map((a) => a.filename)).toEqual(["ACM2026000000001.pdf", "ACM2026000000001.xml"]);
    app.clock.advance(61_000);
    await app.invoices.deliver();
    app.clock.advance(61_000);
    await app.invoices.deliver();
    const d = app.invoices.getInvoice(inv.id);
    expect(d.status).toBe("delivered");
    expect(d.events.map((e) => e.what)).toEqual(["drafted", "issued", "sent to the integrator", "emailed", "delivered"]);
    expect(app.mails).toHaveLength(1);
  });

  it("is refused before GİB, fixed, and issued again under its number with a new ETTN", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id);
    app.integrator.failNext = new IntegratorError("Alıcı etiketi geçersiz", 422, true);
    await app.invoices.deliver();
    const refused = app.invoices.getInvoice(inv.id);
    expect(refused).toMatchObject({ status: "refused", owed: false, integrator: { detail: "Alıcı etiketi geçersiz" } });
    app.invoices.updateInvoice(ECE, inv.id, { notes: "Düzeltildi" });
    expect(() => app.invoices.updateInvoice(ECE, inv.id, { issueDate: "2026-11-01" })).toThrow(/keeps its date/);
    const again = await app.invoices.issue(ECE, inv.id, {});
    expect(again.number).toBe("ACM2026000000001");
    expect(again.uuid).not.toBe(inv.uuid);
    await app.invoices.deliver();
    expect(app.invoices.getInvoice(inv.id).status).toBe("waiting");
    expect((await issued(company.id)).number).toBe("ACM2026000000002");
  });

  it("tries again later when the integrator cannot be reached", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id);
    app.integrator.failNext = new IntegratorError("timeout");
    await app.invoices.deliver();
    expect(app.invoices.getInvoice(inv.id)).toMatchObject({ status: "queued", integrator: { attempts: 1, detail: "timeout" } });
    app.clock.advance(61_000);
    await app.invoices.deliver();
    expect(app.invoices.getInvoice(inv.id).status).toBe("waiting");
  });

  it("takes a TICARIFATURA's rejection: nothing is owed and the goods come back", async () => {
    app.apply((await import("./test-app.ts")).SETTINGS.replace("profile: TEMELFATURA", "profile: TICARIFATURA"));
    const { company } = seedCustomers(app);
    const p = app.invoices.createProduct(ECE, { code: "SRV-1", name: "Sunucu", unitPrice: 5000000, stock: true });
    const inv = await issued(company.id, [{ product: p.code, quantity: 2 }]);
    expect(inv.profile).toBe("TICARIFATURA");
    await app.invoices.deliver();
    app.integrator.answer(inv.uuid!, "rejected", "Fiyat hatalı");
    app.clock.advance(61_000);
    await app.invoices.deliver();
    expect(app.invoices.getInvoice(inv.id)).toMatchObject({ status: "rejected", owed: false, balance: 0 });
    expect(app.invoices.stockMovements(new URLSearchParams()).movements.map((m) => m.quantity)).toEqual([-2, 2]);
  });

  it("refuses to issue without a tax number, or with the default seller", async () => {
    const c = app.invoices.createCustomer(ECE, { name: "Vergisiz", address: { city: "Ankara", district: "Çankaya" } });
    const d = app.invoices.createInvoice(ECE, { customer: c.id, lines: [LINE] });
    await expect(app.invoices.issue(ECE, d.id, {})).rejects.toThrow(/no tax number/);
    app.apply("integrator: { provider: fake }");
    await expect(app.invoices.issue(ECE, d.id, {})).rejects.toThrow(/seller is not set/);
  });
});

describe("taxes and currencies", () => {
  it("issues TEVKIFAT and ISTISNA invoices of the right type", async () => {
    const { company } = seedCustomers(app);
    const t = await issued(company.id, [{ name: "Temizlik hizmeti", unitPrice: 1000000, withholding: "612" }]);
    expect(t).toMatchObject({ type: "TEVKIFAT", totals: { kdv: 200000, withheld: 180000, payable: 1020000 } });
    const i = await issued(company.id, [{ name: "Yurt dışına yazılım hizmeti", unitPrice: 1000000, kdvRate: 0, exemption: "302" }]);
    expect(i).toMatchObject({ type: "ISTISNA", totals: { kdv: 0, payable: 1000000 } });
    expect(() => app.invoices.createInvoice(ECE, { customer: company.id, lines: [{ name: "x", unitPrice: 1, kdvRate: 0 }] })).toThrow(/exemption code/);
    expect(() => app.invoices.createInvoice(ECE, { customer: company.id, lines: [{ name: "x", unitPrice: 1, kdvRate: 18 }] })).toThrow(
      /kdvRate is one of 0, 1, 10, 20/,
    );
    expect(() => app.invoices.createInvoice(ECE, { customer: company.id, lines: [{ name: "x", unitPrice: 1, withholding: "999" }] })).toThrow(/withholding/);
  });

  it("takes TCMB's rate of the bulletin before the invoice's day, or the one given", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id, [{ name: "License", unitPrice: 100000 }], { currency: "USD" });
    expect(inv.rate).toEqual({ value: "34.2512", date: "2026-10-30", source: "tcmb" });
    expect(inv.tryTotals).toEqual({ net: 3425120, kdv: 685024, withheld: 0, total: 4110144, payable: 4110144 });
    expect(textAt(parseXml(app.invoices.invoiceXml(inv.id).xml), "PricingExchangeRate", "CalculationRate")).toBe("34.2512");
    const manual = await issued(company.id, [{ name: "License", unitPrice: 100000 }], { currency: "EUR", rate: "37.5" });
    expect(manual.rate).toEqual({ value: "37.5000", date: null, source: "manual" });
    expect(await app.invoices.getRate(new URLSearchParams({ currency: "EUR", date: "2026-11-02" }))).toEqual({
      currency: "EUR",
      date: "2026-11-02",
      bulletin: "2026-10-30",
      kind: "forex_buying",
      rate: "37.1050",
    });
  });
});

describe("credit notes and cancelling", () => {
  it("corrects an invoice with an IADE credit note naming it, up to what is left to credit", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id);
    const cn = app.invoices.creditNote(ECE, inv.id, { lines: [{ line: 1, quantity: 1 }], reason: "Bir lisans iade edildi." });
    expect(cn).toMatchObject({ kind: "credit_note", status: "draft", original: { id: inv.id, number: inv.number } });
    const done = await app.invoices.issue(ECE, cn.id, {});
    expect(done).toMatchObject({ type: "IADE", number: "ACM2026000000002", totals: { payable: 720000 } });
    const root = parseXml(app.invoices.invoiceXml(cn.id).xml);
    expect(textAt(root, "BillingReference", "InvoiceDocumentReference", "ID")).toBe("ACM2026000000001");
    expect(app.invoices.getInvoice(inv.id)).toMatchObject({ credited: 720000, balance: 720000 });
    const more = app.invoices.creditNote(ECE, inv.id, {});
    await expect(app.invoices.issue(ECE, more.id, {})).rejects.toThrow(/more than what is left to credit/);
  });

  it("cancels an e-Arşiv invoice, but never an e-Fatura", async () => {
    const { company, person } = seedCustomers(app);
    const ef = await issued(company.id);
    const ea = await issued(person.id);
    await app.invoices.deliver();
    await expect(app.invoices.cancel(ECE, ef.id)).rejects.toThrow(/credit note/);
    expect((await app.invoices.cancel(ECE, ea.id)).status).toBe("cancelled");
  });
});

describe("payments and reminders", () => {
  it("takes partial payments up to what is owed, and marks the invoice paid", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id);
    app.invoices.addPayment(ECE, inv.id, { amount: 400000, date: "2026-11-05" });
    expect(app.invoices.getInvoice(inv.id)).toMatchObject({ paid: 400000, balance: 1040000, paidAt: null });
    expect(() => app.invoices.addPayment(ECE, inv.id, { amount: 1040001 })).toThrow(/more than what is owed/);
    const p = app.invoices.addPayment(ECE, inv.id, { amount: 1040000, date: "2026-11-06", method: "card" });
    expect(app.invoices.getInvoice(inv.id)).toMatchObject({ balance: 0, paidAt: "2026-11-06" });
    app.invoices.removePayment(ECE, p.id as string);
    expect(app.invoices.getInvoice(inv.id)).toMatchObject({ balance: 1040000, paidAt: null });
  });

  it("reminds before and after the due day, once each, while it is unpaid", async () => {
    const { company } = seedCustomers(app);
    const inv = await issued(company.id, [LINE], { dueDate: "2026-11-10" });
    await app.invoices.deliver();
    app.mails.length = 0;
    const at = (d: string, hhmm = "06:30") => app.clock.set(Date.parse(`${d}T${hhmm}:00Z`));
    at("2026-11-06");
    await app.invoices.runReminders();
    expect(app.mails).toHaveLength(0);
    at("2026-11-07");
    await app.invoices.runReminders();
    await app.invoices.runReminders();
    expect(app.mails.map((m) => m.subject)).toEqual(["Yaklaşan ödeme: ACM2026000000001"]);
    at("2026-11-11", "05:00"); // 08:00 in Istanbul: before reminders.at
    await app.invoices.runReminders();
    expect(app.mails).toHaveLength(1);
    at("2026-11-11");
    await app.invoices.runReminders();
    expect(app.mails.at(-1)!.subject).toBe("Ödeme hatırlatması: ACM2026000000001");
    expect(app.mails.at(-1)!.text).toContain("Kalan tutar: 14.400,00 TL");
    expect(app.mails.at(-1)!.text).toContain("IBAN TR330006100519786457841326");
    app.invoices.addPayment(ECE, inv.id, { amount: 1440000 });
    at("2026-11-17");
    await app.invoices.runReminders();
    expect(app.mails).toHaveLength(2);
    expect(app.invoices.getInvoice(inv.id).reminders.map((r) => [r.kind, r.days])).toEqual([
      ["before", 3],
      ["after", 1],
    ]);
  });

  it("counts what is owed and overdue, by currency and customer", async () => {
    const { company, person } = seedCustomers(app);
    await issued(company.id, [LINE], { dueDate: "2026-11-02" });
    await issued(person.id);
    app.clock.advance(3 * DAY);
    const s = app.invoices.summary();
    expect(s.owed).toEqual([{ currency: "TRY", owed: 2880000, overdue: 1440000, invoices: 2, overdueInvoices: 1 }]);
    expect(s.customers[0]).toMatchObject({ customer: { name: "Yıldız Mimarlık Ltd. Şti." }, overdue: 1440000 });
    expect(app.invoices.listInvoices(new URLSearchParams({ status: "overdue" })).map((i) => i.daysOverdue)).toEqual([3]);
  });
});

describe("bank statements", () => {
  it("pays the invoice whose number is in the line, or the one of that amount whose customer is named, once", async () => {
    const { company, person } = seedCustomers(app);
    const a = await issued(company.id);
    const b = await issued(person.id, [{ name: "Danışmanlık", unitPrice: 50000 }]);
    const statement = [
      "Tarih;Açıklama;Tutar;Dekont No",
      `03.11.2026;HAVALE ${a.number} YILDIZ;10.000,00;D-1`,
      "03.11.2026;EFT GÜLŞEN ÖZTÜRK ÇAĞLAR;600,00;D-2",
      "03.11.2026;BİLİNMEYEN;123,45;D-3",
      "03.11.2026;KİRA;-5.000,00;D-4",
    ].join("\n");
    const r = app.invoices.importStatement(ECE, { account: "garanti", content: statement });
    expect(r).toMatchObject({ lines: 4, added: 4, matched: 2, unmatched: 1, outgoing: 1 });
    expect(app.invoices.getInvoice(a.id).balance).toBe(440000);
    expect(app.invoices.getInvoice(b.id).balance).toBe(0);
    expect(app.invoices.importStatement(ECE, { account: "garanti", content: statement })).toMatchObject({ added: 0, duplicates: 4, matched: 0 });
    const [left] = app.invoices.listBankLines(new URLSearchParams());
    expect(left).toMatchObject({ amount: 12345, state: "unmatched" });
    expect(() => app.invoices.resolveBankLine(ECE, left!.id as string, { invoice: a.id })).not.toThrow();
    expect(app.invoices.getInvoice(a.id).balance).toBe(440000 - 12345);
  });
});

describe("recurring invoices", () => {
  it("makes and issues one each month on its day, with the period, once", async () => {
    const { company } = seedCustomers(app);
    const t = app.invoices.createRecurring(ECE, {
      name: "Bakım sözleşmesi",
      customer: company.id,
      lines: [LINE],
      start: "2026-10-31",
      everyMonths: 1,
      end: "2026-12-31",
    });
    await app.invoices.runRecurring();
    await app.invoices.runRecurring();
    let all = app.invoices.listInvoices(new URLSearchParams({ q: "" })).filter((i) => i.source === "recurring");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "queued", period: { start: "2026-10-31", end: "2026-11-29" }, issueDate: "2026-11-02" });
    expect(app.invoices.getRecurring(t.id as string)).toMatchObject({ next: "2026-11-30", made: 1 });
    app.clock.set(Date.parse("2026-11-30T07:00:00Z"));
    await app.invoices.runRecurring();
    app.clock.set(Date.parse("2026-12-31T07:00:00Z"));
    await app.invoices.runRecurring();
    all = app.invoices.listInvoices(new URLSearchParams()).filter((i) => i.source === "recurring");
    expect(all.map((i) => i.period?.start).sort()).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    expect(app.invoices.getRecurring(t.id as string)).toMatchObject({ active: false, next: null, made: 3 });
  });

  it("leaves a draft and says why when it cannot be issued", async () => {
    const c = app.invoices.createCustomer(ECE, { name: "Vergisiz", address: { city: "Ankara", district: "Çankaya" } });
    const t = app.invoices.createRecurring(ECE, { name: "Kira", customer: c.id, lines: [LINE], start: "2026-11-02" });
    await app.invoices.runRecurring();
    expect(app.invoices.getRecurring(t.id as string).lastError).toMatch(/no tax number/);
    expect(app.invoices.listInvoices(new URLSearchParams({ status: "draft" }))).toHaveLength(1);
  });
});

describe("CRM's won deals", () => {
  const deal = (id: string, closedAt: string, quote = true) => ({
    id,
    name: "Yıldız: 12 lisans",
    status: "won",
    value: 108000,
    currency: "TRY",
    closedAt,
    company: { id: "co-1", name: "Yıldız Mimarlık Ltd. Şti." },
    contact: { id: "ct-1", name: "Hakan Yıldız", email: "hakan@yildiz.example" },
    companyDetail: { id: "co-1", name: "Yıldız Mimarlık Ltd. Şti.", city: "İzmir", domain: "yildiz.example" },
    contactDetail: { id: "ct-1", name: "Hakan Yıldız", email: "hakan@yildiz.example" },
    quotes: quote
      ? [
          { number: "Q-2026-7", state: "declined", vat: 20, lines: [{ item: "Eski", quantity: 1, unitPrice: 1, discount: 0, total: 1 }] },
          { number: "Q-2026-9", state: "accepted", vat: 20, lines: [{ item: "Lisans", quantity: 12, unitPrice: 9000.5, discount: 10, total: 97205.4 }] },
        ]
      : [],
  });

  it("drafts each deal won after the link was set up, once, from its accepted quote", async () => {
    app.fakes.crm.deals.set("old", deal("old", "2026-10-01T10:00:00.000Z"));
    await app.invoices.runCrm();
    expect(app.invoices.listInvoices(new URLSearchParams())).toHaveLength(0);
    app.fakes.crm.deals.set("d-1", deal("d-1", "2026-11-02T07:00:00.000Z"));
    app.fakes.crm.deals.set("d-2", deal("d-2", "2026-11-02T07:00:00.000Z", false));
    app.clock.advance(3_600_000);
    await app.invoices.runCrm();
    await app.invoices.runCrm();
    const list = app.invoices.listInvoices(new URLSearchParams());
    expect(list).toHaveLength(2);
    const one = list.find((i) => i.sourceRef === "crm:d-1")!;
    expect(one).toMatchObject({ source: "crm", status: "draft", orderRef: "Q-2026-9" });
    expect(one.lines).toEqual([expect.objectContaining({ name: "Lisans", quantity: 12, unitPrice: 900050, discount: 10, kdvRate: 20 })]);
    const two = list.find((i) => i.sourceRef === "crm:d-2")!;
    expect(two.lines).toEqual([expect.objectContaining({ name: "Yıldız: 12 lisans", unitPrice: 10800000 })]);
    // The customer is made once, from CRM's company, and needs its tax number before issuing.
    const customers = app.invoices.listCustomers(new URLSearchParams());
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ crmCompany: "co-1", taxId: null, email: "hakan@yildiz.example", address: { city: "İzmir" } });
    // An older deal is drafted by hand.
    const byHand = await app.invoices.fromDeal(ECE, "old");
    expect(byHand.created).toBe(true);
    expect((await app.invoices.fromDeal(ECE, "old")).created).toBe(false);
  });
});

describe("exports", () => {
  it("writes the invoices with KDV by rate and withholding as Excel opens them in Turkish, and the XML files", async () => {
    const { company } = seedCustomers(app);
    await issued(company.id, [LINE, { name: "Kurulum", unitPrice: 100000, kdvRate: 10 }]);
    await issued(company.id, [{ name: "Temizlik", unitPrice: 1000000, withholding: "612" }]);
    const f = app.invoices.exportInvoices(new URLSearchParams({ from: "2026-11-01", to: "2026-11-30" }));
    expect(f.body.startsWith("﻿Belge;Fatura no;ETTN")).toBe(true);
    const rows = f.body.trim().split("\r\n").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(";ACM2026000000001;");
    expect(rows[0]).toContain(";12000,00;2400,00;");
    expect(rows[0]).toContain(";1000,00;100,00;");
    expect(rows[1]).toContain(";612 9/10;");
    const z = app.invoices.exportUbl(new URLSearchParams({ from: "2026-11-01", to: "2026-11-30" }));
    expect(z.body.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(z.body.includes(Buffer.from("ACM2026000000002.xml"))).toBe(true);
    app.invoices.addPayment(ECE, app.invoices.listInvoices(new URLSearchParams())[0]!.id, { amount: 100 });
    expect(app.invoices.exportPayments(new URLSearchParams({ from: "2026-11-01", to: "2026-11-30" })).body).toContain(";1,00;bank;");
  });
});
