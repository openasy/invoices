# invoices

[![CI](https://github.com/openasy/invoices/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/invoices/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Invoices product: customers, products and services, invoices and credit
notes with KDV and its withholding (tevkifat), issued as e-Fatura or e-Arşiv through the GİB special integrator you
already use, under GİB's numbering, with the PDF, payments in full or in part, reminders on the days you set,
recurring invoices, bank statements matched to invoices, invoices in foreign currencies at TCMB's rate, and exports
for your accountant. It does not keep the books, and it is not an integrator itself: only integrators with an API can
be connected.

**There are no screens yet.** No designs exist for Invoices, so this repository has the server, the API, the settings
file, the integrator and its fake, the PDF, the links to other products, and the tests. There is no `web/`; everything
is done through the API (its reference is at `/api/docs/`).

```
invoices.yaml ──▶ invoices ──▶ GİB integrator (Nilvera's API): e-Fatura, e-Arşiv, status, cancel
                    │ ▲  └───▶ TCMB: /kurlar/YYYYMM/DDMMYYYY.xml        SMTP: invoices and reminders
                    │ ├── CRM: won deals are read (GET /api/v1/deals?status=won)
                    │ ├── Time: POST /api/v1/billable-items      Helpdesk: GET /api/v1/lookup
                    │ └── Inventory: GET /api/v1/stock-movements  Audience: POST /api/v1/erasures
                    └──── bank statements (CSV, MT940): POST /api/v1/bank/statements
```

## Money and records

Every amount is a whole number of minor units: kuruş for TRY (`4500050` is 45.000,50 TL), cents for EUR and USD, in
the API, the database and every sum. Quantities have up to three decimals, discounts are a percentage with up to two.

- **Customers** have a VKN (10 digits) or a TCKN (11, with its check digits; `11111111111` for a person who gives
  none), a tax office, an address with its district (ilçe), an email, a currency and payment terms of their own. A
  customer from CRM may have no tax number yet; it is needed before issuing.
- **Catalog**: products and services with a code, a unit (UN/ECE codes: `C62` piece, `HUR` hour, `MON` month), a price
  without KDV, a KDV rate, a withholding or exemption code, and `stock` for goods Inventory counts.
- **Invoices and credit notes** have lines (from the catalog or written in), each rounded once, half up; the totals
  are sums of the lines. Each invoice keeps the seller and the buyer as they were when it was issued.
- **Payments** are in the invoice's currency, in full or in part, never more than what is owed. What is owed is the
  payable amount less payments and issued credit notes.

## Numbers

GİB's 16 characters: a three-character series, the year and nine digits, `ACM2026000000001`. `series.e_fatura` and
`series.e_arsiv` each count on their own and start again at 1 every year.

- A draft has no number. Issuing gives the next one in the same write transaction (`BEGIN IMMEDIATE`) that fixes the
  invoice, after its XML has passed every check: an invoice that would be refused gets no number, so none is skipped,
  and two invoices issued at the same moment never get the same one.
- A number is never dated before the one before it in its series. An invoice is dated today or up to seven days back
  (VUK 231/5), never in the future.
- An invoice with a number is never deleted. A sent one is never changed; a credit note corrects it.
- An invoice the integrator refused before it reached GİB (`refused`) or that GİB failed (`failed`) is not an invoice
  yet: it may be fixed and issued again under its number and date, with a new ETTN.

## KDV, withholding and exemptions

- **KDV** rates are `kdv_rates` (0, 1, 10 and 20 by default, the rates since July 2023). A line with 0% needs an
  exemption code (TaxExemptionReasonCode): 301, 302 and 351 are built in, and `exemptions` adds others from GİB's list.
- **Withholding** (KDV tevkifat): a line with a code (601 to 614, 624 to 627 built in, with their shares; `withholding`
  in the file changes a share or adds a code, such as 801 for full withholding) withholds that share of its KDV. The
  invoice is `TEVKIFAT`; the KDV is shown in full, the withheld part on its own line, and the buyer pays the total less
  it. The share is fixed on the line when it is written, so a later file does not change an invoice.
- The **type** follows the lines: `SATIS`; `TEVKIFAT` with withholding; `ISTISNA` when every line is exempt (0% with
  an exemption code other than 351); `IADE` for a credit note. Withholding and exempt lines are not mixed in one invoice.

Check the shares and the codes with your accountant: they change by communiqué, and the built-in table is what
KDV Genel Uygulama Tebliği said when this was written.

## UBL-TR and the integrator

Invoices writes the invoice as **UBL-TR 1.2** XML (`CustomizationID` TR1.2, UBL 2.1's element order, `ProfileID`
TEMELFATURA, TICARIFATURA or EARSIVFATURA) and checks it before it is sent: the number and its year, the ETTN, the
parties (VKN with `PartyName`, TCKN with `Person`, the district, city and country, the seller's tax office), KDV and
withholding per line and in total, the exemption codes, `BillingReference` on an IADE, `SendingType` on e-Arşiv,
`PricingExchangeRate` for a foreign currency, one currency for every amount, and `LineExtensionAmount`,
`TaxExclusiveAmount`, `TaxInclusiveAmount` and `PayableAmount` to the kuruş. These are the rules of GİB's schematron
an invoice of this product can break, written here; they are not GİB's own XSD and schematron, which the integrator
runs too. Invoices does not sign: in the special integration model the integrator signs with its financial seal.

**e-Fatura or e-Arşiv** is decided when issuing: the integrator is asked whether the buyer's tax number is on GİB's
e-Fatura list. A registered buyer gets e-Fatura, sent to their first alias (posta kutusu etiketi), with the file's
`integrator.profile` (TEMELFATURA, or TICARIFATURA, which the buyer may accept or refuse within eight days); anyone
else gets e-Arşiv, which Invoices emails with its PDF.

An issued invoice goes `queued` (to be sent), `waiting` (the integrator has it), `delivered` (GİB took it), and for a
TICARIFATURA `accepted` or `rejected` by the buyer. A rejected invoice is not owed and its goods come back. An e-Arşiv
invoice can be `cancelled` through the integrator while it has no payments; an e-Fatura cannot, and a credit note
corrects it. Sending is tried again after 1, 2, 4 minutes and so on up to 6 hours while the integrator cannot be
reached.

The integrator is behind one interface (`IntegratorApi` in `server/integrator.ts`: lookup, send, status, cancel).

- `nilvera` follows [Nilvera's API reference](https://developer.nilvera.com): Bearer API key;
  `GET /general/GlobalCompany/GetGlobalCustomerInfo/{TaxNumber}?globalUserType=Invoice` for the aliases,
  `POST /einvoice/Send/Xml?Alias=` and `POST /earchive/Send/Xml` with the XML as the multipart `file`,
  `GET /einvoice/Sale/{UUID}/Status` (InvoiceStatus and the buyer's Answer), `GET /earchive/Invoices/{UUID}/Status`
  and `PUT /earchive/Invoices/{UUID}/Cancel`. A 409 on sending is taken as sent (an earlier try whose answer was lost).
- `fake` keeps everything in the process and sends nothing to GİB: tax numbers are e-Fatura users, identity numbers
  are not, and it refuses XML that fails the checks. Use it to try Invoices.

Another integrator with an API is another implementation of the interface. Integrators that offer only SOAP or a portal
are not connected.

## Credit notes

A credit note is drafted from an issued invoice (`POST /api/v1/invoices/{id}/credit-notes`), with every line or the
lines and quantities given, and issued like an invoice: an `IADE` invoice in the same channel's series, naming the
original in `BillingReference`. It reduces what is owed, up to what is left to credit; goods on it come back to the
stock. Whether the seller or the buyer issues the return invoice depends on the case; ask your accountant.

## Payments, reminders and bank statements

- Payments are recorded by hand or come from a bank statement. A payment more than what is owed is refused.
- **Reminders** go by email with the PDF at `reminders.at`, `before` the due day and `after` it while the invoice is
  unpaid, each once; a later one sent means an earlier one is not sent late. `POST /api/v1/invoices/{id}/email` sends the
  invoice or a reminder now.
- **Bank statements** are imported as files: CSV with the columns `bank.<id>.csv` names (or Excel saved as CSV; the
  header may be below the bank's own lines), or MT940. A line of money in pays the owed invoice whose number is in its
  text, or the one owed invoice of exactly that amount whose customer's name or tax number is in it; the rest wait to be
  matched by hand or ignored. A line seen before is not added again, so a statement imported twice pays nothing twice.

## Recurring invoices

A recurring invoice has a customer, lines, every how many months, a start and an end. On its day it makes an invoice
with the period it covers and issues it (`mode: issue`) or leaves a draft (`mode: draft`); a day is made once. One
that cannot be issued is left as a draft and the reason kept on the recurring invoice. The 31st is the last day of
shorter months.

## Foreign currencies

An invoice in EUR, USD or another currency takes TCMB's rate (`exchange_rates.rate`, forex buying by default) of the
last bulletin published before its date: TCMB publishes at 15:30 the rates of the next day, so an invoice of Monday
takes Friday's. The rate can also be given on the invoice. The XML carries `PricingExchangeRate`; the PDF and the
exports show the TRY values.

## Exports for the accountant

- `GET /api/v1/exports/invoices.csv?from=&to=`: every issued invoice and credit note with KDV base and amount by rate,
  withholding and its codes, exemption codes, TRY values, paid and owed. Semicolons and decimal commas, UTF-8 with its
  mark, as Excel opens them in Turkish.
- `GET /api/v1/exports/payments.csv` and `GET /api/v1/exports/ubl.zip` (the XML files, `NUMBER.xml`).

## What other products call, and what Invoices calls

- **CRM.** CRM sends nothing, so with `crm` in the file Invoices reads `GET /api/v1/deals?status=won` every
  `check_every`, with a CRM token of the viewer role, and drafts an invoice from each deal won since the link was set
  up, once per deal: the lines of its accepted quote (else the last sent one) with the quote's KDV, or one line with the
  deal's name and value (`DealDetail` in crm/openapi.json; CRM's amounts are converted to kuruş). The customer is the
  one linked to the CRM company, or the one with the contact's email, or one made from the company; CRM keeps no tax
  number, so it is completed before issuing. `POST /api/v1/crm/deals/{id}` drafts an older deal by hand.
- **Time** (not built yet) sends approved billable hours with `POST /api/v1/billable-items`:
  `{ "items": [{ "external_id", "customer": { "taxId" | "email" | "crmCompany" | "id" }, "date", "description", "quantity", "unit", "unitPrice", "currency", "kdvRate" }] }`.
  The same `external_id` is taken once; a draft takes items as lines with `billableItems`, and a deleted draft lets
  them go.
- **Helpdesk** can show a customer's invoices beside a billing question: `GET /api/v1/lookup?email=` (exactly,
  lowercased) or `?number=` answers `InvoicesLookup`: the customer, what they owe and overdue by currency, and their
  last ten invoices; 404 when nothing matches. Helpdesk does not call it yet.
- **Inventory** (not built yet) reads `GET /api/v1/stock-movements?after=<seq>`: goods that left with an invoice
  (negative quantities) and came back with a credit note or a cancelled or rejected invoice, in order, with `next` to
  ask from.
- **Audience** deletes a person with `POST /api/v1/erasures` and a token of the admin role, as in
  audience/README.md. While one of their invoices is unpaid the answer is 202 `waiting`. Then a customer with no
  issued invoice is deleted with their drafts; one with issued invoices keeps them for ten years (VUK 253, TTK 82) and
  loses their email, phone and notes, and the answer says so.

The [OpenAPI description](./openapi.json) is the full contract.

## The settings file

Everything but the records is in [config/invoices.yaml](./config/invoices.yaml), read at start and again within a
minute of a change, applied whole or not at all; a file with a mistake leaves the last good version in place.
`GET /api/v1/settings` shows it as applied.

| Key | Default | |
| --- | --- | --- |
| `time_zone`, `currency`, `language` | `Europe/Istanbul`, `TRY`, `tr` | `language` is the PDF's and the emails': `tr` or `en` |
| `seller` | none: nothing is issued | `{ name, tax_id, tax_office, address: { street, district, city, postal_code, country }, email, phone, website, mersis, trade_registry, iban, bank }` |
| `series` | `FAT`, `ARS` | `{ e_fatura, e_arsiv }`, three letters or digits each |
| `payment_terms` | `30d` | The due day, unless the customer has their own |
| `kdv_rates` | `[0, 1, 10, 20]` | |
| `withholding` | 601 to 614, 624 to 627 | `"<code>": { name, share: 2/10 }` |
| `exemptions` | 301, 302, 351 | `"<code>": <name>` |
| `integrator` | none: nothing is issued | `{ provider: nilvera or fake, url, api_key, profile: TEMELFATURA or TICARIFATURA, poll_every }`; `api_key` names a variable |
| `exchange_rates` | TCMB, `forex_buying` | `{ url, rate }` |
| `reminders` | `before: [3d]`, `after: [1d, 7d, 30d]`, `09:00` | `{ before, after, at }` |
| `email_on_issue` | `true` | Email each issued invoice with its PDF and XML |
| `mail` | | `{ host, port, security, user, password, from }`; `password` names a variable |
| `bank.<id>` | | `{ name, iban, currency, format: csv or mt940, csv: { date, amount or credit and debit, description, reference, separator, date_format, decimal } }` |
| `crm` | | `{ url, token, won_deals: draft or off, check_every }` |
| `notes` | | A note on every invoice |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/invoices.yaml
docker compose up -d
docker compose logs invoices | grep 'no owner yet'
```

There is no default password (ADR 0013), and no screens yet to open the link in, so the owner is made through the
sign-in API of [@openasy/auth](https://github.com/openasy/auth) with the token from the link's `?setup=`, then sets up
two-step verification, which owners need before anything else, and makes an API token:

```bash
U=https://invoices.example.com/api/v1/auth; O="Origin: https://invoices.example.com"; J="content-type: application/json"
curl -c jar -H "$O" -H "$J" -d '{"token":"<setup token>","email":"you@example.com","name":"You","password":"<a long password>"}' $U/setup
curl -b jar -H "$O" -X POST $U/me/totp                      # add the secret to your authenticator app
curl -b jar -H "$O" -H "$J" -d '{"code":"123456"}' $U/me/totp/confirm
curl -b jar -H "$O" -H "$J" -d '{"name":"scripts","role":"editor"}' $U/tokens   # the token, shown once
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `INVOICES_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `INVOICES_CONFIG` | `/config/invoices.yaml` | The settings file |
| the variables the file names | | The integrator's API key, the mail password, the CRM token |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `INVOICES_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key: sign-in secrets |
| `INVOICES_DB` | `/data/invoices.db` | SQLite file (WAL), on the `/data` volume; it holds the issued XML, so back it up |
| `INVOICES_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `INVOICES_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

Viewers read everything; editors make and issue invoices, record payments and import statements; admins also answer
erasures. The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.
Metrics include invoices by status, the integrator's results, reminders and emails by result, and unmatched bank lines.
The lookup's email is not written to the request log.

## Develop

```bash
npm install
npm test           # the file, KDV, withholding and rounding, UBL-TR written and each check broken once, numbering
                   # (in order, never skipped, never twice under load), the integrator's states, credit notes,
                   # payments, reminders, recurring invoices, bank statements, TCMB, CRM, the PDF read back with
                   # pdf.js, the exports, the contracts, and every API response against openapi.json
npm run openapi    # writes openapi.json after an API change; a test fails while it is out of date
npm start          # the server, with INVOICES_DB and INVOICES_CONFIG pointing at local files
```

**Tested against fakes only.** Nothing here has been sent to a real integrator or to GİB.

- The Nilvera adapter was written from Nilvera's published reference and is tested against `server/fakes.ts`, which
  answers in those shapes. Nilvera's real answers, error bodies, test system, and how it handles a resent XML are not
  tested.
- The UBL-TR checks are ours. The XML has not been run through GİB's XSD and schematron package or GİB's test portal;
  a real integrator may refuse what these checks pass.
- TCMB's bulletins, CRM's deals and SMTP are fakes in the tests (the mailer keeps what it is given).
- The withholding shares, exemption codes, the seven-day rule and the e-Arşiv cancellation are as Invoices understood
  them when this was written; check them with your accountant and your integrator.

## Licence

AGPL-3.0 (ADR 0008).
