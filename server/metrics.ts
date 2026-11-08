// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Invoices by status: draft, queued, waiting, delivered and so on. */
  byStatus: Record<string, number>;
  /** Bank lines that pay no invoice yet. */
  unmatched: number;
  counters: { sent: Map<string, number>; reminders: Map<string, number>; emails: Map<string, number> };
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

const STATUSES = ["draft", "queued", "waiting", "delivered", "accepted", "rejected", "refused", "failed", "cancelled"];

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="invoices",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_invoices_invoices Invoices and credit notes, by status.",
    "# TYPE openasy_invoices_invoices gauge",
    ...STATUSES.map((s) => `openasy_invoices_invoices{status="${s}"} ${g.byStatus[s] ?? 0}`),
    "# HELP openasy_invoices_unmatched_bank_lines Money in from bank statements that pays no invoice yet.",
    "# TYPE openasy_invoices_unmatched_bank_lines gauge",
    `openasy_invoices_unmatched_bank_lines ${g.unmatched}`,
    "# HELP openasy_invoices_integrator_total What the integrator did with invoices: sent, refused, delivered, accepted, rejected, failed.",
    "# TYPE openasy_invoices_integrator_total counter",
    ...[...g.counters.sent].map(([k, n]) => `openasy_invoices_integrator_total{result="${k}"} ${n}`),
    "# HELP openasy_invoices_reminders_total Payment reminders, by result.",
    "# TYPE openasy_invoices_reminders_total counter",
    ...[...g.counters.reminders].map(([k, n]) => `openasy_invoices_reminders_total{result="${k}"} ${n}`),
    "# HELP openasy_invoices_emails_total Invoices emailed when issued, by result.",
    "# TYPE openasy_invoices_emails_total counter",
    ...[...g.counters.emails].map(([k, n]) => `openasy_invoices_emails_total{result="${k}"} ${n}`),
    "# HELP openasy_invoices_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_invoices_config_error gauge",
    `openasy_invoices_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
