import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
// Money is kept in minor units (kuruş for TRY) as integers, quantities in thousandths, discounts in hundredths of a
// percent and exchange rates in ten-thousandths, so no sum ever rounds.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- Who is invoiced. tax_id is a VKN (10 digits) or TCKN (11), or empty until it is known (a customer from CRM); 11111111111 is GİB's number for a person who gives
   -- none, so it may repeat. einvoice_aliases is what the integrator said about the tax id: the e-Fatura mailboxes
   -- (posta kutusu etiketleri), or [] when it is not an e-Fatura user and gets e-Arşiv.
   CREATE TABLE customers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     tax_id TEXT NOT NULL,
     tax_office TEXT,
     street TEXT,
     district TEXT,
     city TEXT NOT NULL,
     postal_code TEXT,
     country TEXT NOT NULL,
     email TEXT,
     phone TEXT,
     currency TEXT,
     payment_days INTEGER,
     crm_company_id TEXT UNIQUE,
     einvoice_aliases TEXT,
     einvoice_checked_at TEXT,
     notes TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX customers_tax_id ON customers (tax_id) WHERE tax_id NOT IN ('11111111111', '');
   CREATE INDEX customers_email ON customers (email);
   CREATE INDEX customers_name ON customers (name COLLATE NOCASE);
   -- What is sold: a product or a service with its price without KDV and its taxes. stock marks goods Inventory counts.
   CREATE TABLE products (
     id TEXT PRIMARY KEY,
     code TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     unit TEXT NOT NULL,
     unit_price INTEGER NOT NULL,
     currency TEXT NOT NULL,
     kdv_rate INTEGER NOT NULL,
     withholding TEXT,
     exemption TEXT,
     stock INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- An invoice or a credit note. A draft has no number. Issuing gives it the next number of its series and year,
   -- fixes the seller, the buyer, the lines and the UBL-TR XML, and queues it for the integrator; from then on it is
   -- never changed, unless the integrator refused it before it reached GİB (refused, failed), when it may be fixed and
   -- sent again under the same number.
   CREATE TABLE invoices (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
     status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'waiting', 'delivered', 'accepted', 'rejected', 'refused', 'failed', 'cancelled')),
     channel TEXT CHECK (channel IN ('e-fatura', 'e-arsiv')),
     profile TEXT,
     type_code TEXT,
     series TEXT,
     year INTEGER,
     seq INTEGER,
     number TEXT UNIQUE,
     uuid TEXT UNIQUE,
     customer_id TEXT NOT NULL REFERENCES customers (id),
     seller TEXT,
     buyer TEXT,
     alias TEXT,
     issue_date TEXT,
     issue_time TEXT,
     due_date TEXT,
     currency TEXT NOT NULL,
     rate INTEGER,
     rate_source TEXT,
     rate_date TEXT,
     notes TEXT,
     order_ref TEXT,
     period_start TEXT,
     period_end TEXT,
     original_id TEXT REFERENCES invoices (id),
     source TEXT NOT NULL,
     source_ref TEXT UNIQUE,
     net INTEGER NOT NULL DEFAULT 0,
     kdv INTEGER NOT NULL DEFAULT 0,
     withheld INTEGER NOT NULL DEFAULT 0,
     total INTEGER NOT NULL DEFAULT 0,
     payable INTEGER NOT NULL DEFAULT 0,
     xml TEXT,
     integrator_ref TEXT,
     integrator_detail TEXT,
     next_at TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     email_to TEXT,
     email INTEGER NOT NULL DEFAULT 1,
     emailed_at TEXT,
     paid_at TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     issued_at TEXT,
     issued_by TEXT,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX invoices_customer ON invoices (customer_id, issue_date);
   CREATE INDEX invoices_status ON invoices (status, due_date);
   CREATE INDEX invoices_due ON invoices (next_at) WHERE next_at IS NOT NULL;
   CREATE INDEX invoices_original ON invoices (original_id) WHERE original_id IS NOT NULL;
   CREATE TABLE invoice_lines (
     invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
     pos INTEGER NOT NULL,
     product_id TEXT REFERENCES products (id) ON DELETE SET NULL,
     code TEXT,
     name TEXT NOT NULL,
     description TEXT,
     quantity INTEGER NOT NULL,
     unit TEXT NOT NULL,
     unit_price INTEGER NOT NULL,
     discount INTEGER NOT NULL DEFAULT 0,
     kdv_rate INTEGER NOT NULL,
     withholding TEXT,
     withholding_tenths INTEGER NOT NULL DEFAULT 0,
     exemption TEXT,
     stock INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (invoice_id, pos)
   ) WITHOUT ROWID;
   -- What happened to an invoice, for its history: issued, sent, the integrator's answers, emails, payments.
   CREATE TABLE invoice_events (
     id INTEGER PRIMARY KEY,
     invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     by_name TEXT NOT NULL,
     what TEXT NOT NULL,
     detail TEXT
   );
   CREATE INDEX invoice_events_invoice ON invoice_events (invoice_id, id);
   -- The last number of each series and year, and the date it was given on: the next one is last + 1, never on an
   -- earlier date.
   CREATE TABLE number_series (series TEXT NOT NULL, year INTEGER NOT NULL, last INTEGER NOT NULL, last_date TEXT NOT NULL, PRIMARY KEY (series, year)) WITHOUT ROWID;
   -- Money received against an invoice, in its currency. bank_line_id when it came from a statement.
   CREATE TABLE payments (
     id TEXT PRIMARY KEY,
     invoice_id TEXT NOT NULL REFERENCES invoices (id),
     date TEXT NOT NULL,
     amount INTEGER NOT NULL CHECK (amount > 0),
     method TEXT NOT NULL CHECK (method IN ('bank', 'cash', 'card', 'other')),
     reference TEXT,
     note TEXT,
     bank_line_id TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE INDEX payments_invoice ON payments (invoice_id, date);
   -- Bank statements imported as files, and their lines. A line seen before (same account, day, amount, reference
   -- and text) is not added again, so a statement imported twice pays nothing twice.
   CREATE TABLE bank_statements (
     id TEXT PRIMARY KEY,
     account TEXT NOT NULL,
     filename TEXT,
     imported_at TEXT NOT NULL,
     imported_by TEXT NOT NULL
   );
   CREATE TABLE bank_lines (
     id TEXT PRIMARY KEY,
     statement_id TEXT NOT NULL REFERENCES bank_statements (id) ON DELETE CASCADE,
     account TEXT NOT NULL,
     date TEXT NOT NULL,
     amount INTEGER NOT NULL,
     currency TEXT NOT NULL,
     description TEXT NOT NULL,
     reference TEXT,
     fingerprint TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('matched', 'unmatched', 'ignored', 'outgoing')),
     invoice_id TEXT REFERENCES invoices (id),
     UNIQUE (account, fingerprint)
   );
   CREATE INDEX bank_lines_state ON bank_lines (state, date);
   -- An invoice made again every few months: the lines, and the day the next one is due.
   CREATE TABLE recurring (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     customer_id TEXT NOT NULL REFERENCES customers (id),
     currency TEXT NOT NULL,
     lines TEXT NOT NULL,
     notes TEXT,
     every_months INTEGER NOT NULL,
     day_of_month INTEGER NOT NULL,
     start_date TEXT NOT NULL,
     end_date TEXT,
     next_date TEXT,
     mode TEXT NOT NULL CHECK (mode IN ('issue', 'draft')),
     active INTEGER NOT NULL DEFAULT 1,
     made INTEGER NOT NULL DEFAULT 0,
     last_invoice_id TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- Reminders sent: one row per invoice and reminder, so none goes twice.
   CREATE TABLE reminders (
     invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('before', 'after')),
     days INTEGER NOT NULL,
     sent_at TEXT NOT NULL,
     error TEXT,
     PRIMARY KEY (invoice_id, kind, days)
   ) WITHOUT ROWID;
   -- TCMB's rates, by the day of the bulletin, kept so an invoice made again finds the same rate.
   CREATE TABLE exchange_rates (date TEXT NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL, rate INTEGER NOT NULL, PRIMARY KEY (date, currency, kind)) WITHOUT ROWID;
   -- Hours and other items another product sent to be invoiced (Time's billable hours), until an invoice takes them.
   CREATE TABLE billable_items (
     id TEXT PRIMARY KEY,
     external_id TEXT NOT NULL UNIQUE,
     source TEXT NOT NULL,
     customer_id TEXT NOT NULL REFERENCES customers (id),
     date TEXT NOT NULL,
     description TEXT NOT NULL,
     quantity INTEGER NOT NULL,
     unit TEXT NOT NULL,
     unit_price INTEGER NOT NULL,
     currency TEXT NOT NULL,
     kdv_rate INTEGER NOT NULL,
     invoice_id TEXT REFERENCES invoices (id) ON DELETE SET NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX billable_items_open ON billable_items (customer_id) WHERE invoice_id IS NULL;
   -- Goods that left (issued invoices) or came back (credit notes), in order, for Inventory to read.
   CREATE TABLE stock_movements (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     invoice_id TEXT NOT NULL REFERENCES invoices (id),
     number TEXT NOT NULL,
     product_id TEXT,
     code TEXT NOT NULL,
     quantity INTEGER NOT NULL,
     unit TEXT NOT NULL,
     date TEXT NOT NULL,
     at TEXT NOT NULL
   );
   -- Deletions Audience asked for, by their reference: kept so asking again gives the same answer.
   CREATE TABLE erasures (reference TEXT PRIMARY KEY, at TEXT NOT NULL, status TEXT NOT NULL, deleted INTEGER NOT NULL, detail TEXT);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
