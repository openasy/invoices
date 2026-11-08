import { describe, expect, it } from "vitest";
import { configWarnings, isDefaultSeller, parseConfig, validIban } from "./config.ts";
import { SETTINGS } from "./test-app.ts";

describe("invoices.yaml", () => {
  it("has defaults for everything, and no seller or integrator, so nothing can be issued", () => {
    const c = parseConfig("");
    expect(c).toMatchObject({ timeZone: "Europe/Istanbul", currency: "TRY", series: { eFatura: "FAT", eArsiv: "ARS" }, paymentDays: 30, integrator: null });
    expect(c.tax.kdvRates).toEqual([0, 1, 10, 20]);
    expect(isDefaultSeller(c)).toBe(true);
    expect(configWarnings(c, {}).join(" ")).toMatch(/seller.*integrator/s);
  });

  it("reads the test file", () => {
    const c = parseConfig(SETTINGS.replaceAll("FAKES", "http://fakes"));
    expect(c.seller).toMatchObject({ name: "Acme Yazılım A.Ş.", taxId: "1234567890", iban: "TR330006100519786457841326" });
    expect(c.integrator).toMatchObject({ provider: "fake", profile: "TEMELFATURA", pollMinutes: 1 });
    expect(c.bank.map((b) => [b.id, b.format])).toEqual([
      ["garanti", "csv"],
      ["isbank", "mt940"],
    ]);
    expect(c.reminders).toEqual({ before: [3], after: [1, 7], at: 540 });
    expect(configWarnings(c, { CRM_TOKEN: "x" })).toEqual(["integrator: fake, so nothing reaches GİB. Use it only to try Invoices."]);
  });

  it("adds and changes withholding and exemption codes", () => {
    const c = parseConfig('withholding: { "624": { share: 3/10 }, "801": { name: Tam tevkifat, share: 10/10 } }\nexemptions: { "350": Diğerleri }');
    expect(c.tax.withholding.get("624")).toEqual({ code: "624", name: "Yük taşımacılığı hizmeti", tenths: 3 });
    expect(c.tax.withholding.get("801")?.tenths).toBe(10);
    expect(c.tax.exemptions.get("350")).toEqual({ code: "350", name: "Diğerleri", exempt: true });
  });

  it("says what is wrong, by its key", () => {
    const wrong: Array<[string, RegExp]> = [
      ["nope: 1", /unknown nope/],
      ["series: { e_fatura: AB }", /series.e_fatura is three letters/],
      ["series: { e_fatura: ABC, e_arsiv: ABC }", /different series/],
      ["seller: { name: X, tax_id: '12', tax_office: Y, address: { city: Z } }", /seller.tax_id/],
      ["seller: { name: X, tax_id: '1234567890', tax_office: Y, address: { city: Z }, iban: TR00 0000 }", /seller.iban/],
      ["integrator: { provider: paper }", /only integrators with an API/i],
      ["integrator: { provider: nilvera, api_key: abc123 }", /environment variable/],
      ["withholding: { '624': { share: 3/7 } }", /tenths/],
      ["kdv_rates: [8.5]", /whole percentages/],
      ["reminders: { after: [0d] }", /reminders.after\[0\]/],
      ["exchange_rates: { rate: average }", /forex_buying/],
      ["crm: { url: ftp://crm }", /crm.url/],
      ["bank: { a: { format: ofx } }", /csv or mt940/],
      ["time_zone: Mars/Base", /not a time zone/],
      ["a: [", /Not valid YAML/],
    ];
    for (const [text, re] of wrong) expect(() => parseConfig(text), text).toThrow(re);
  });

  it("checks Turkish IBANs by their check digits", () => {
    expect(validIban("TR330006100519786457841326")).toBe(true);
    expect(validIban("TR340006100519786457841326")).toBe(false);
  });
});
