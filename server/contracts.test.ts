// What other products call, as they would call it. Helpdesk, Time and Inventory do not call these yet (Time and
// Inventory are not built, and Helpdesk shows only CRM beside a ticket today); these are the contracts Invoices offers
// them. Audience's erasures follow audience/README.md.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ECE, seedCustomers, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
let ids: ReturnType<typeof seedCustomers>;
beforeAll(async () => {
  app = await startApp();
  ids = seedCustomers(app);
});
afterAll(() => app.close());

describe("Helpdesk: GET /api/v1/lookup", () => {
  it("answers the customer, what they owe and their last invoices, by email or by an invoice number", async () => {
    const d = app.invoices.createInvoice(ECE, { customer: ids.company.id, lines: [{ name: "Lisans", unitPrice: 100000 }], dueDate: "2026-11-01" });
    const inv = await app.invoices.issue(ECE, d.id, {});
    const res = await app.admin(`/api/v1/lookup?${new URLSearchParams({ email: "MUHASEBE@yildiz.example" })}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      customer: {
        id: ids.company.id,
        name: "Yıldız Mimarlık Ltd. Şti.",
        email: "muhasebe@yildiz.example",
        taxId: "9876543210",
        url: `${app.base}/customers/${ids.company.id}`,
      },
      owed: [{ currency: "TRY", amount: 120000, overdue: 120000 }],
      invoices: [
        {
          id: inv.id,
          number: "ACM2026000000001",
          kind: "invoice",
          date: "2026-11-02",
          due: "2026-11-01",
          currency: "TRY",
          payable: 120000,
          balance: 120000,
          status: "queued",
          overdue: true,
          url: `${app.base}/invoices/${inv.id}`,
        },
      ],
    });
    expect(((await (await app.admin("/api/v1/lookup?number=acm2026000000001")).json()) as typeof body).customer).toMatchObject({ id: ids.company.id });
    expect((await app.admin("/api/v1/lookup?email=muhasebe@yildiz.example.com")).status).toBe(404);
  });
});

describe("Time: POST /api/v1/billable-items", () => {
  it("takes approved hours once, and a draft takes them as lines", async () => {
    const items = [
      {
        external_id: "time-entry-1",
        customer: { email: "gulsen@example.com" },
        date: "2026-10-30",
        description: "Danışmanlık, Ece Kılıç",
        quantity: 2.5,
        unitPrice: 150000,
      },
      {
        external_id: "time-entry-2",
        customer: { taxId: "10000000146" },
        date: "2026-10-31",
        description: "Eğitim",
        quantity: 1,
        unitPrice: 150000,
        kdvRate: 10,
      },
    ];
    const first = await app.admin("/api/v1/billable-items", { method: "POST", body: JSON.stringify({ items }) });
    expect(await first.json()).toMatchObject({ added: 2, existing: 0 });
    const again = await app.admin("/api/v1/billable-items", { method: "POST", body: JSON.stringify({ items }) });
    expect(await again.json()).toMatchObject({ added: 0, existing: 2 });
    const open = app.invoices.listBillable(new URLSearchParams({ customer: ids.person.id }));
    expect(open.map((i) => [i.quantity, i.unit])).toEqual([
      [2.5, "HUR"],
      [1, "HUR"],
    ]);
    const d = app.invoices.createInvoice(ECE, { customer: ids.person.id, billableItems: open.map((i) => i.id as string) });
    expect(d.lines.map((l) => [l.name, l.net])).toEqual([
      ["Danışmanlık, Ece Kılıç", 375000],
      ["Eğitim", 150000],
    ]);
    expect(app.invoices.listBillable(new URLSearchParams({ customer: ids.person.id }))).toHaveLength(0);
    expect(() => app.invoices.createInvoice(ECE, { customer: ids.person.id, billableItems: [open[0]!.id as string] })).toThrow(/on an invoice already/);
    // A draft deleted lets its items go back.
    app.invoices.removeInvoice(ECE, d.id);
    expect(app.invoices.listBillable(new URLSearchParams({ customer: ids.person.id }))).toHaveLength(2);
  });
});

describe("Inventory: GET /api/v1/stock-movements", () => {
  it("lists goods that left and came back, in order, from a cursor", async () => {
    app.invoices.createProduct(ECE, { code: "KBL-5", name: "Kablo, 5 m", unit: "C62", unitPrice: 25000, stock: true });
    app.invoices.createProduct(ECE, { code: "SRV", name: "Kurulum", unit: "HUR", unitPrice: 100000 });
    const d = app.invoices.createInvoice(ECE, {
      customer: ids.company.id,
      lines: [
        { product: "KBL-5", quantity: 10 },
        { product: "SRV", quantity: 2 },
      ],
    });
    const inv = await app.invoices.issue(ECE, d.id, {});
    const cn = app.invoices.creditNote(ECE, inv.id, { lines: [{ line: 1, quantity: 3 }] });
    await app.invoices.issue(ECE, cn.id, {});
    const res = (await (await app.admin("/api/v1/stock-movements?after=0")).json()) as { movements: Array<Record<string, unknown>>; next: number };
    expect(res.movements.map((m) => [m.code, m.quantity, m.number])).toEqual([
      ["KBL-5", -10, inv.number],
      ["KBL-5", 3, "ACM2026000000003"],
    ]);
    const after = (await (await app.admin(`/api/v1/stock-movements?after=${res.next}`)).json()) as typeof res;
    expect(after).toEqual({ movements: [], next: res.next });
  });
});

describe("Audience: POST /api/v1/erasures", () => {
  const ask = (reference: string, emails: string[]) =>
    app.admin("/api/v1/erasures", { method: "POST", body: JSON.stringify({ reference, product: "audience", people: { emails, phones: [], userIds: [] } }) });

  it("waits while an invoice is unpaid, then keeps the issued invoices and removes the rest", async () => {
    const c = app.invoices.createCustomer(ECE, {
      name: "Nihan Er",
      taxId: "11111111111",
      address: { district: "Bodrum", city: "Muğla" },
      email: "nihan@er.example",
      phone: "0532 000 00 12",
    });
    const d = app.invoices.createInvoice(ECE, { customer: c.id, lines: [{ name: "Oda", unitPrice: 300000 }] });
    const inv = await app.invoices.issue(ECE, d.id, {});
    const waiting = await ask("KVKK-2026-031", ["nihan@er.example"]);
    expect(waiting.status).toBe(202);
    expect(await waiting.json()).toEqual({ status: "waiting", detail: "1 invoice is not yet paid." });
    app.invoices.addPayment(ECE, inv.id, { amount: inv.totals.payable });
    const done = await ask("KVKK-2026-031", ["nihan@er.example"]);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({
      status: "done",
      deleted: 1,
      detail: "1 issued invoice is kept for ten years, as VUK 253 and TTK 82 ask; the email and phone were removed.",
    });
    expect(app.invoices.getCustomer(c.id)).toMatchObject({ email: null, phone: null });
    expect(app.invoices.getInvoice(inv.id).number).toBe(inv.number);
    expect(await (await ask("KVKK-2026-031", [])).json()).toMatchObject({ status: "done", deleted: 1 });
  });

  it("deletes a customer who has no issued invoice", async () => {
    const c = app.invoices.createCustomer(ECE, { name: "Taslak Müşteri", address: { city: "Ankara" }, email: "taslak@example.com" });
    app.invoices.createInvoice(ECE, { customer: c.id, lines: [{ name: "x", unitPrice: 1 }] });
    expect(await (await ask("KVKK-2026-040", ["taslak@example.com"])).json()).toEqual({ status: "done", deleted: 1 });
    expect(() => app.invoices.getCustomer(c.id)).toThrow(/does not exist/);
  });
});
