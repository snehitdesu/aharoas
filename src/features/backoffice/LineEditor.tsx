"use client";

/**
 * Editable document lines (material + numeric fields) for indents, purchase
 * orders, GRNs, bills, transfers, issues and wastage. It only collects input;
 * totals, stock checks and workflow rules are computed by the server.
 */
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { FieldError, Input } from "@/components/ui/Form";
import { MaterialSelect, type MaterialRow } from "@/features/backoffice/lookups";

export type LineField = { key: string; label: string; required?: boolean; min?: number; step?: string; placeholder?: string; type?: "number" | "text" | "date" };
export type LineDraft = { materialId: string } & Record<string, string>;

export const emptyLine = (fields: LineField[]): LineDraft => ({ materialId: "", ...Object.fromEntries(fields.map((f) => [f.key, ""])) });

export function LineEditor({ fields, lines, onChange, materials }: { fields: LineField[]; lines: LineDraft[]; onChange: (lines: LineDraft[]) => void; materials: MaterialRow[] }) {
  const set = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? ({ ...l, ...patch } as LineDraft) : l)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-ink-700">Lines</legend>
      <FieldError name="lines" />
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-md border border-ink-100 p-2" role="group" aria-label={`Line ${i + 1}`}>
          <label className="col-span-12 flex flex-col gap-0.5 text-xs text-ink-500 sm:col-span-5">
            <span>Material</span>
            <MaterialSelect materials={materials} value={l.materialId} onChange={(id) => set(i, { materialId: id })} required aria-label={`Line ${i + 1} material`} />
          </label>
          {fields.map((f) => (
            <label key={f.key} className="col-span-6 flex flex-col gap-0.5 text-xs text-ink-500 sm:col-span-2">
              <span>{f.label}</span>
              <Input
                type={f.type ?? "number"}
                inputMode={f.type === "text" ? undefined : "decimal"}
                step={f.step ?? "any"}
                min={f.min}
                required={f.required}
                placeholder={f.placeholder}
                value={l[f.key] ?? ""}
                onChange={(e) => set(i, { [f.key]: e.target.value })}
                aria-label={`Line ${i + 1} ${f.label}`}
              />
            </label>
          ))}
          <div className="col-span-12 flex justify-end sm:col-span-1">
            <Button size="sm" variant="ghost" onClick={() => onChange(lines.filter((_, j) => j !== i))} disabled={lines.length === 1} aria-label={`Remove line ${i + 1}`}>
              <Icon name="trash" />
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => onChange([...lines, emptyLine(fields)])}>
          <Icon name="plus" /> Add line
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * Convert drafts to API lines: numeric fields become numbers, empty optional
 * fields are omitted, and blank rows (no material) are dropped.
 */
export function toApiLines(lines: LineDraft[], fields: LineField[]): Array<Record<string, string | number>> {
  return lines
    .filter((l) => l.materialId)
    .map((l) => {
      const out: Record<string, string | number> = { materialId: l.materialId };
      for (const f of fields) {
        const v = (l[f.key] ?? "").trim();
        if (v === "") continue;
        out[f.key] = f.type === "text" || f.type === "date" ? v : Number(v);
      }
      return out;
    });
}
