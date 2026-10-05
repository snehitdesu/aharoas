/**
 * In-process operational metrics (provider-agnostic).
 *
 * Counters live in this process (one app instance — docs/production-readiness
 * M6) and are exposed in the Prometheus text format by GET /api/health/metrics
 * (bearer METRICS_TOKEN). Any scraper (Prometheus, Grafana Agent, Datadog,
 * a cron + curl) can read them; nothing here depends on a monitoring vendor.
 * Gauges that describe durable state (outbox backlog, stuck jobs, backups) are
 * computed at scrape time from the database — see ops/opsStatus.ts.
 *
 * Label values are fixed vocabularies (status classes, kinds) — never ids,
 * emails or free text — so the series count stays bounded.
 */

type Labels = Record<string, string>;
const counters = new Map<string, { name: string; labels: Labels; value: number }>();
const HELP: Record<string, string> = {
  restora_http_requests_total: "API requests handled, by status class",
  restora_http_5xx_total: "API requests that ended in a server error",
  restora_auth_failures_total: "Failed sign-in / re-authentication attempts",
  restora_webhooks_total: "Inbound webhooks, by kind and outcome",
  restora_payment_failures_total: "Payment operations that failed (gateway rejection, failed capture webhook, verification error)",
  restora_integration_failures_total: "Outbound integration attempts that failed, by kind",
  restora_job_failures_total: "Background job failures, by job type",
  restora_db_errors_total: "Database errors reported by the client",
  restora_keyed_lock_waits_total: "Transactions that queued in-process behind another one on the same key (e.g. settlements at one outlet) instead of colliding in the database",
  restora_db_serialization_conflicts_total: "Serialization conflicts (P2034) — retried by runInTx; sustained growth = write contention",
  restora_alerts_total: "Alerts raised, by key",
  restora_app_errors_total: "Error-level log events",
};

const keyOf = (name: string, labels: Labels) => `${name}|${Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",")}`;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,48}$/;

export function inc(name: keyof typeof HELP | string, labels: Labels = {}, by = 1): void {
  const clean: Labels = {};
  for (const [k, v] of Object.entries(labels)) clean[k] = LABEL_VALUE.test(v) ? v : "other";
  const k = keyOf(name, clean);
  const c = counters.get(k);
  if (c) c.value += by;
  else counters.set(k, { name, labels: clean, value: by });
}

export function counterValue(name: string, labels: Labels = {}): number {
  return counters.get(keyOf(name, labels))?.value ?? 0;
}

/** Tests only. */
export function resetMetrics(): void {
  counters.clear();
}

export type Gauge = { name: string; help: string; value: number; labels?: Labels };

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const fmtLabels = (l?: Labels) => (l && Object.keys(l).length ? `{${Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : "");

/** Prometheus text exposition (version 0.0.4). */
export function renderPrometheus(gauges: Gauge[] = []): string {
  const lines: string[] = [];
  const byName = new Map<string, { labels: Labels; value: number }[]>();
  for (const c of counters.values()) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }
  for (const [name, series] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} counter`);
    for (const s of series) lines.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
  }
  const seen = new Set<string>();
  for (const g of gauges) {
    if (!seen.has(g.name)) {
      lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      seen.add(g.name);
    }
    lines.push(`${g.name}${fmtLabels(g.labels)} ${Number.isFinite(g.value) ? g.value : 0}`);
  }
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  lines.push(
    "# HELP restora_process_cpu_seconds_total User + system CPU time", "# TYPE restora_process_cpu_seconds_total counter", `restora_process_cpu_seconds_total ${((cpu.user + cpu.system) / 1e6).toFixed(3)}`,
    "# HELP restora_process_uptime_seconds Process uptime", "# TYPE restora_process_uptime_seconds gauge", `restora_process_uptime_seconds ${Math.round(process.uptime())}`,
    "# HELP restora_process_resident_memory_bytes Resident memory", "# TYPE restora_process_resident_memory_bytes gauge", `restora_process_resident_memory_bytes ${mem.rss}`,
    "# HELP restora_process_heap_used_bytes V8 heap used", "# TYPE restora_process_heap_used_bytes gauge", `restora_process_heap_used_bytes ${mem.heapUsed}`,
  );
  return `${lines.join("\n")}\n`;
}
