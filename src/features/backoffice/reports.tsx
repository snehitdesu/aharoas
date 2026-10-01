"use client";

/**
 * Report center + export jobs. The report list is what the server says the
 * caller may run; filters are sent as-is (date-only strings = outlet business
 * days, resolved server-side); rows are capped and offset-paged by the server.
 * CSV exports go through /api/exports (inline download or background job),
 * which re-authorizes, audits and rate-limits every export.
 */
import { useState } from "react";
import { api, apiDownload, saveBlob } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, formatMoney, humanize, isoDay } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { DataTable, Pager } from "@/components/ui/Table";
import { Card, PageHeader, StatusBadge } from "@/components/ui/Page";
import { ErrorState, LoadingState, EmptyState } from "@/components/ui/States";
import { DateRangeFilter, FilterBar, SelectFilter, type DateRange } from "@/components/ui/Filters";
import { FormAlert, formError } from "@/components/ui/Form";
import { useToast } from "@/components/ui/Toast";

export type ReportMeta = { id: string; title: string; permission: string; maxRows: number; aggregate: boolean; columns: Array<{ key: string; header: string }> };
type ReportResult = { report: string; title: string; columns: Array<{ key: string; header: string }>; rows: Array<Record<string, unknown>>; rowCount: number; truncated: boolean; offset: number; nextOffset: number | null };
type ExportJob = { id: string; kind: string; status: string; outletId: string | null; rowCount: number | null; error: string | null; filePath: string | null; createdAt: string; finishedAt: string | null };

const PAGE = 200;
const MONEY_KEYS = /amount|sales|total|value|cost|revenue|paid|due|spend|profit|margin|refund|discount|tax/i;

/** Render a report cell: numbers in money-like columns as currency, ISO dates as local dates. */
export function renderCell(key: string, v: unknown, tz?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return MONEY_KEYS.test(key) && !/count|qty|orders|points|covers|pct/i.test(key) ? formatMoney(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDateTime(v, tz);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export function ReportsScreen() {
  const { can, outletId, outlet } = useShell();
  const toast = useToast();
  const today = isoDay(new Date(), outlet?.timezone);
  const reports = useQuery<ReportMeta[]>("/api/reports");
  const [reportId, setReportId] = useState("");
  const [range, setRange] = useState<DateRange>({ from: today.slice(0, 8) + "01", to: today });
  const [offset, setOffset] = useState<number[]>([0]);
  const [exporting, setExporting] = useState<"inline" | "background" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const selected = reports.data?.find((r) => r.id === reportId) ?? reports.data?.[0];
  // Date-only strings: the server turns them into the outlet's business days.
  const filters = { outletId: outletId ?? undefined, from: range.from || undefined, to: range.to || undefined };
  const invalid = Boolean(range.from && range.to && range.from > range.to);
  const result = useQuery<ReportResult>(selected && !invalid ? `/api/reports/${selected.id}` : null, { ...filters, limit: PAGE, offset: offset.at(-1) });
  const pick = (id: string) => { setReportId(id); setOffset([0]); };
  const setRangeReset = (r: DateRange) => { setRange(r); setOffset([0]); };

  const doExport = async (mode: "inline" | "background") => {
    if (!selected || exporting) return;
    setExporting(mode);
    setExportError(null);
    try {
      if (mode === "inline") {
        const { blob, filename, headers } = await apiDownload("/api/exports", { method: "POST", body: { report: selected.id, filters, mode } });
        saveBlob(blob, filename);
        toast.show(`Exported ${headers.get("x-row-count") ?? ""} rows${headers.get("x-truncated") === "true" ? " (capped)" : ""}`, "ok");
      } else {
        await api("/api/exports", { method: "POST", body: { report: selected.id, filters, mode } });
        toast.show("Export queued — find it under Exports", "ok");
      }
    } catch (e) {
      setExportError(formError(e));
    } finally {
      setExporting(null);
    }
  };

  if (reports.error) return <><PageHeader title="Reports" /><ErrorState error={reports.error} onRetry={reports.reload} /></>;
  if (!reports.data) return <LoadingState />;
  if (!reports.data.length) return <><PageHeader title="Reports" /><EmptyState title="No reports available" hint="Your role doesn't include any report permissions at this outlet." /></>;
  const r = result.data;
  return (
    <>
      <PageHeader title="Reports" subtitle={`${outlet?.name ?? ""} · business days in the outlet's timezone`}
        actions={can("export.run") && selected && (
          <>
            <Button onClick={() => doExport("inline")} loading={exporting === "inline"} disabled={invalid}><Icon name="download" /> Download CSV</Button>
            <Button onClick={() => doExport("background")} loading={exporting === "background"} disabled={invalid}>Export in background</Button>
          </>
        )} />
      <FormAlert message={exportError} />
      <FilterBar>
        <SelectFilter label="Report" value={selected?.id ?? ""} onChange={(v) => v && pick(v)} options={reports.data.map((x) => ({ value: x.id, label: x.title }))} anyLabel="Select report…" />
        <DateRangeFilter value={range} onChange={setRangeReset} />
      </FilterBar>
      {invalid ? <p className="text-sm text-bad-500">The start date must be on or before the end date.</p> : result.error ? <ErrorState error={result.error} onRetry={result.reload} /> : (
        <>
          {r?.truncated && <p className="mb-2 text-xs text-ink-500">Showing rows {r.offset + 1}–{r.offset + r.rowCount}. More rows are available.</p>}
          <DataTable<Record<string, unknown>> label={selected?.title ?? "Report"} rows={r?.rows ?? []} rowKey={(row) => JSON.stringify(row)} loading={result.loading} empty="No rows for this period"
            columns={(r?.columns ?? selected?.columns ?? []).map((c) => ({ key: c.key, header: c.header, numeric: r?.rows.some((row) => typeof row[c.key] === "number"), cell: (row) => renderCell(c.key, row[c.key], outlet?.timezone) }))} />
          <Pager page={offset.length} hasPrev={offset.length > 1 && !result.loading} hasNext={Boolean(r?.nextOffset) && !result.loading} prev={() => setOffset((o) => o.slice(0, -1))} next={() => r?.nextOffset && setOffset((o) => [...o, r.nextOffset!])} />
        </>
      )}
    </>
  );
}

// ============================================================
// Export jobs
// ============================================================

export function ExportsScreen() {
  const { outlets } = useShell();
  const [status, setStatus] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = usePaged<ExportJob>("/api/exports");
  const rows = list.items.filter((j) => !status || j.status === status);
  const pending = list.items.some((j) => j.status === "PENDING" || j.status === "RUNNING");
  const download = async (job: ExportJob) => {
    setDownloading(job.id);
    setErr(null);
    try {
      const { blob, filename } = await apiDownload(`/api/exports/${job.id}/download`);
      saveBlob(blob, filename);
    } catch (e) {
      setErr(formError(e));
    } finally {
      setDownloading(null);
    }
  };
  return (
    <>
      <PageHeader title="Exports" subtitle="CSV export jobs (yours; org-wide roles see all)" actions={<Button onClick={list.reload} aria-label="Refresh exports"><Icon name="refresh" /> Refresh</Button>} />
      <FormAlert message={err} />
      {pending && <Card className="mb-3"><p className="text-sm text-ink-700">Some exports are still running — refresh to update their status.</p></Card>}
      <FilterBar><SelectFilter label="Status" value={status} onChange={setStatus} options={["PENDING", "RUNNING", "SUCCESS", "FAILED"]} /></FilterBar>
      <DataTable label="Export jobs" rows={rows} rowKey={(j) => j.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No exports yet — run one from Reports"
        columns={[
          { key: "c", header: "Requested", cell: (j) => formatDateTime(j.createdAt) },
          { key: "k", header: "Report", cell: (j) => humanize(j.kind) },
          { key: "o", header: "Outlet", cell: (j) => (j.outletId ? outlets.find((o) => o.id === j.outletId)?.name ?? "Other outlet" : "All") },
          { key: "s", header: "Status", cell: (j) => <StatusBadge status={j.status} /> },
          { key: "r", header: "Rows", numeric: true, cell: (j) => j.rowCount ?? "—" },
          { key: "f", header: "Finished", cell: (j) => formatDateTime(j.finishedAt) },
          { key: "e", header: "", cell: (j) => (j.status === "SUCCESS" && j.filePath ? <Button size="sm" onClick={() => download(j)} loading={downloading === j.id}><Icon name="download" /> Download</Button> : j.status === "FAILED" ? <span className="text-xs text-bad-500">{j.error ?? "Failed"}</span> : j.status === "SUCCESS" ? <span className="text-xs text-ink-500">Downloaded inline</span> : null) },
        ]} />
      <Pager {...list} />
    </>
  );
}
