// What the web screens ask the server for beyond the records: a draft's totals before it is saved (the same rounding as
// issuing), the overview, the reminders an invoice gets, export counts, statements, and customers and products from CSV.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAY } from "./store.ts";
import { ECE, seedCustomers, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeEach(async () => {
  app = await startApp();
});
afterEach(() => app.close());

const LINE = { name: "Danışmanlık", quantity: 40, unitPrice: 240000, kdvRate: 20 };

describe("preview", () => {
  it("gives the totals a saved draft has, line by line, with KDV and withholding", () => {
    const { company } = seedCustomers(app);
    const lines = [
      { ...LINE, withholding: "602" },
      { name: "Kurulum", quantity: 1.333, unitPrice: 33333, discount: 12.5, kdvRate: 20 },
      { name: "Kitap", quantity: 3, unitPrice: 9999, kdvRate: 1 },
    ];
    const p = app.invoices.preview({ customer: company.id, lines });
    const saved = app.invoices.createInvoice(ECE, { customer: company.id, lines });
    expect(p.totals).toEqual(saved.totals);
    expect(p.lines).toEqual(saved.lines.map((l) => ({ net: l.net, kdv: l.kdv, withheld: l.withheld })));
    expect(p.totals.withholdingBreakdown).toEqual([{ code: "602", share: "9/10", base: 1920000, amount: 1728000 }]);
    expect(p.type).toBe("TEVKIFAT");
  });

  it("names the channel by the customer's check and the number issuing would give", async () => {
    const { company, person } = seedCustomers(app);
    expect(app.invoices.preview({ customer: company.id, lines: [LINE] })).toMatchObject({ channel: "e-arsiv", channelKnown: false, next: "ACA2026000000001" });
    await app.invoices.checkCustomer(company.id);
    await app.invoices.checkCustomer(person.id);
    expect(app.invoices.preview({ customer: company.id, lines: [LINE] })).toMatchObject({
      channel: "e-fatura",
      channelKnown: true,
      profile: "TEMELFATURA",
      alias: "urn:mail:defaultpk@9876543210.example",
      next: "ACM2026000000001",
    });
    const d = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE] });
    await app.invoices.issue(ECE, d.id, {});
    expect(app.invoices.preview({ customer: company.id, lines: [LINE] }).next).toBe("ACM2026000000002");
    expect(app.invoices.preview({ customer: person.id, lines: [LINE] })).toMatchObject({ channel: "e-arsiv", channelKnown: true, profile: "EARSIVFATURA" });
    expect(app.invoices.preview({ original: d.id, kind: "credit_note", lines: [LINE] })).toMatchObject({ channel: "e-fatura", type: "IADE" });
  });

  it("counts a line without a name yet, and refuses what a draft would refuse", () => {
    const { company } = seedCustomers(app);
    expect(app.invoices.preview({ customer: company.id, lines: [{ quantity: 1, unitPrice: 1000, kdvRate: 20 }] }).totals.payable).toBe(1200);
    expect(app.invoices.preview({ customer: company.id, lines: [] }).type).toBeNull();
    expect(() => app.invoices.preview({ customer: company.id, lines: [{ ...LINE, kdvRate: 0 }] })).toThrow(/exemption code/);
    const mixed = app.invoices.preview({
      customer: company.id,
      lines: [
        { ...LINE, withholding: "602" },
        { ...LINE, kdvRate: 0, exemption: "301" },
      ],
    });
    expect(mixed.typeError).toMatch(/withholding cannot also have exempt lines/);
  });
});

describe("overview", () => {
  it("sums what is owed and overdue in TL, by age, month and customer", async () => {
    const { company, person } = seedCustomers(app);
    const a = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE], dueDate: "2026-11-10" });
    await app.invoices.issue(ECE, a.id, {});
    const b = app.invoices.createInvoice(ECE, { customer: person.id, lines: [{ name: "Ders", unitPrice: 100000, kdvRate: 20 }] });
    await app.invoices.issue(ECE, b.id, {});
    const usd = app.invoices.createInvoice(ECE, {
      customer: company.id,
      currency: "USD",
      rate: "34.5000",
      lines: [{ name: "Lisans", unitPrice: 10000, kdvRate: 20 }],
    });
    await app.invoices.issue(ECE, usd.id, {});
    app.invoices.addPayment(ECE, a.id, { amount: 1520000, date: "2026-11-02" });
    app.clock.advance(20 * DAY);
    const o = app.invoices.overview();
    expect(o.today).toBe("2026-11-22");
    // a: 11.520.000 less 1.520.000 paid, 12 days late; b: 120.000, due in 30 days; usd: 120 USD at 34,50 = 414.000.
    expect(o.owed).toEqual({ amount: 10000000 + 120000 + 414000, invoices: 3 });
    expect(o.overdue).toEqual({ amount: 10000000, invoices: 1, oldestDays: 12 });
    expect(o.ages).toEqual([
      { age: "current", amount: 534000 },
      { age: "1-30", amount: 10000000 },
      { age: "31-60", amount: 0 },
      { age: "60+", amount: 0 },
    ]);
    expect(o.collected).toEqual({ month: "2026-11", amount: 1520000, payments: 1, fromBank: 0 });
    expect(o.months.at(-1)).toEqual({ month: "2026-11", paid: 9600000 + 100000 + 345000 - 8333333 - 100000 - 345000, owed: 8333333 + 100000 + 345000 });
    expect(o.months).toHaveLength(6);
    expect(o.customers[0]).toMatchObject({
      customer: { id: company.id },
      invoices: 2,
      owed: 10414000,
      overdue: 10000000,
      oldest: { id: a.id, daysOverdue: 12 },
    });
    expect(o.waiting).toEqual({ drafts: 0, refused: 0 });
  });

  it("averages the days from issue to paid in full", async () => {
    const { company } = seedCustomers(app);
    const a = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE] });
    await app.invoices.issue(ECE, a.id, {});
    app.clock.advance(10 * DAY);
    app.invoices.addPayment(ECE, a.id, { amount: 11520000 });
    expect(app.invoices.overview().daysToPay).toEqual({ last90: 10, previous90: null });
  });
});

describe("recurring invoices", () => {
  it("say what each invoice comes to", () => {
    const { company } = seedCustomers(app);
    const r = app.invoices.createRecurring(ECE, { name: "Danışmanlık", customer: company.id, lines: [{ ...LINE, withholding: "602" }], start: "2026-12-01" });
    expect(r.totals).toEqual({ net: 9600000, kdv: 1920000, withheld: 1728000, payable: 9792000 });
  });
});

describe("the reminders of an invoice", () => {
  it("lists the file's days with what was sent, what is planned and what passed", async () => {
    const { company } = seedCustomers(app);
    const a = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE], dueDate: "2026-11-05" });
    await app.invoices.deliver();
    const issued = await app.invoices.issue(ECE, a.id, {});
    expect(issued.reminderPlan.map((r) => [r.kind, r.days, r.on, r.state])).toEqual([
      ["before", 3, "2026-11-02", "planned"],
      ["after", 1, "2026-11-06", "planned"],
      ["after", 7, "2026-11-12", "planned"],
    ]);
    app.clock.advance(5 * DAY);
    await app.invoices.runReminders();
    const later = app.invoices.getInvoice(a.id).reminderPlan;
    expect(later.map((r) => r.state)).toEqual(["passed", "sent", "planned"]);
    app.invoices.addPayment(ECE, a.id, { amount: 11520000 });
    expect(app.invoices.getInvoice(a.id).reminderPlan.map((r) => r.state)).toEqual(["passed", "sent", "stopped"]);
    const draft = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE] });
    expect(draft.reminderPlan).toEqual([]);
  });
});

describe("exports and statements", () => {
  it("counts what the exports of a period hold, and lists the statements imported", async () => {
    const { company } = seedCustomers(app);
    const a = app.invoices.createInvoice(ECE, { customer: company.id, lines: [LINE] });
    await app.invoices.issue(ECE, a.id, {});
    const cn = app.invoices.creditNote(ECE, a.id, { lines: [{ line: 1, quantity: 1 }] });
    await app.invoices.issue(ECE, cn.id, {});
    const r = app.invoices.importStatement(ECE, {
      account: "garanti",
      filename: "kasim.csv",
      content: "Tarih;Açıklama;Tutar;Dekont No\n02.11.2026;HAVALE ACM2026000000001;100,00;D-1\n",
    });
    expect(r.matched).toBe(1);
    const p = new URLSearchParams({ from: "2026-11-01", to: "2026-11-30" });
    expect(app.invoices.exportCounts(p)).toEqual({ from: "2026-11-01", to: "2026-11-30", invoices: 1, creditNotes: 1, payments: 1, xml: 2 });
    expect(app.invoices.listStatements()).toMatchObject([{ account: "garanti", filename: "kasim.csv", importedBy: ECE.name, lines: 1 }]);
  });
});

describe("CSV imports", () => {
  it("adds and changes customers, all or none", () => {
    seedCustomers(app);
    const ok = app.invoices.importCustomers(ECE, {
      content: [
        "name;tax_id;tax_office;street;district;city;email;payment_days",
        "Yıldız Mimarlık Ltd. Şti.;9876543210;Karşıyaka;Atatürk Cad. 12;Konak;İzmir;hakan@yildiz.example;45",
        '"Polat Gıda; San. A.Ş.";7310098821;Nilüfer;;Nilüfer;Bursa;seda@polat.example;15d',
      ].join("\n"),
    });
    expect(ok).toEqual({ added: 1, updated: 1, errors: [] });
    const list = app.invoices.listCustomers(new URLSearchParams());
    expect(list.find((c) => c.taxId === "9876543210")).toMatchObject({ taxOffice: "Karşıyaka", paymentDays: 45 });
    expect(list.find((c) => c.taxId === "7310098821")).toMatchObject({ name: "Polat Gıda; San. A.Ş.", paymentDays: 15 });

    const wrong = app.invoices.importCustomers(ECE, {
      content: "name,tax_id,city\nEr Turizm,3320781146,Antalya\nBozuk,123,Ankara\n,3320781147,\n",
    });
    expect(wrong.added).toBe(0);
    expect(wrong.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(app.invoices.listCustomers(new URLSearchParams({ q: "Er Turizm" }))).toHaveLength(0);
    expect(() => app.invoices.importCustomers(ECE, { content: "name" })).toThrow(/header row and at least one row/);
  });

  it("adds and changes products, with prices as people write them", () => {
    app.invoices.createProduct(ECE, { code: "CONSULT", name: "Danışmanlık", unit: "HUR", unitPrice: 200000 });
    const r = app.invoices.importProducts(ECE, {
      content: [
        "code;name;unit;unit_price;currency;kdv_rate;withholding;exemption",
        "CONSULT;Danışmanlık;HUR;2.400,00;TRY;20;602;",
        "BOOKS-EU;Acme Books abroad;ANN;90.50;EUR;0;;302",
      ].join("\n"),
    });
    expect(r).toEqual({ added: 1, updated: 1, errors: [] });
    const items = app.invoices.listProducts(new URLSearchParams());
    expect(items.find((p) => p.code === "CONSULT")).toMatchObject({ unitPrice: 240000, withholding: "602" });
    expect(items.find((p) => p.code === "BOOKS-EU")).toMatchObject({ unitPrice: 9050, currency: "EUR", kdvRate: 0, exemption: "302" });
    const wrong = app.invoices.importProducts(ECE, { content: "code;name;unit_price;kdv_rate\nX;x;abc;20\nY;y;10;0\n" });
    expect(wrong.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(wrong.added).toBe(0);
  });
});

describe("the web UI", () => {
  it("serves the built pages, with index.html for every page path, and keeps /api/ for the API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invoices-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Invoices</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    const web = await startApp({ webDir: dir });
    try {
      const page = await fetch(`${web.base}/invoices/abc`);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("<title>Invoices</title>");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect((await fetch(`${web.base}/assets/app.js`)).headers.get("content-type")).toBe("text/javascript");
      const api = await fetch(`${web.base}/api/v1/nothing`);
      expect([api.status, api.headers.get("content-type")]).toEqual([404, "application/problem+json"]);
    } finally {
      await web.close();
    }
  });
});
