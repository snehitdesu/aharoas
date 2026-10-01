"use client";

/**
 * Recipes back office: list, detail with version history, DRAFT editing
 * (yield, effective date, lines), approval / archiving, and costing.
 *
 * Mirrors the recipe service exactly: recipes are organization-wide, so
 * authoring needs recipe.manage and approval / archiving recipe.approve, each
 * from an org-wide role; only DRAFT versions are editable; the version
 * lifecycle is the shared RECIPE_VERSION_TRANSITIONS table. Costing, cycle
 * checks and unit conversion all happen on the server.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { usePaged, useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDate, formatDateTime, formatMoney, formatPrecise, formatQty, humanize, toNumber } from "@/lib/format";
import { RECIPE_VERSION_TRANSITIONS, RecipeComponentType, RecipeOutputType, type RecipeStatus } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, Input, Select, Textarea, opt, optNum } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { ActiveBadge, Card, Details, PageHeader, Stat, StatusBadge } from "@/components/ui/Page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { FilterBar, SearchInput, SelectFilter } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";
import { TransitionBar } from "@/features/backoffice/documents";
import { MaterialSelect, useMaterials, useUnits, type UnitRow } from "@/features/backoffice/lookups";

type Num = string | number;
export type RecipeListRow = {
  id: string; name: string; outputType: string; active: boolean; menuItemId: string | null; outputMaterialId: string | null;
  menuItem: { name: string } | null; versions: Array<{ id: string; version: number; status: string; effectiveFrom: string }>;
};
export type RecipeLine = { id: string; componentType: string; materialId: string | null; subRecipeId: string | null; qty: Num; unitId: string | null; wastagePct: Num; sortOrder: number; name: string | null; sku: string | null; unit: string | null };
export type RecipeVersion = {
  id: string; version: number; status: string; effectiveFrom: string; yieldQty: Num; yieldUnitId: string | null; yieldUnit: string | null; servingSize: Num;
  notes: string | null; approvedAt: string | null; createdAt: string; lines: RecipeLine[];
};
export type Recipe = {
  id: string; name: string; outputType: string; active: boolean; menuItemId: string | null; outputMaterialId: string | null; createdAt: string;
  menuItem: { id: string; name: string; price: Num } | null; outputMaterial: { id: string; name: string; sku: string; unit: string | null } | null;
  versions: RecipeVersion[];
};
type Cost = { total: number; quantity: number; lines: Array<{ materialId: string; name: string | null; sku: string | null; unit: string | null; quantity: number; unitCost: number; cost: number }> };
type MenuPick = { id: string; name: string; active: boolean };

function useRecipeAuthority() {
  const { can, orgWide } = useShell();
  return { manage: can("recipe.manage") && orgWide, approve: can("recipe.approve") && orgWide };
}

const latest = (r: { versions: Array<{ version: number; status: string }> }) => r.versions[0];
const approvedCount = (r: { versions: Array<{ status: string }> }) => r.versions.filter((v) => v.status === "APPROVED").length;

// ============================================================
// List
// ============================================================

function CreateRecipeDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { outletId, can } = useShell();
  const [d, setD] = useState({ name: "", outputType: "MENU_ITEM", menuItemId: "", outputMaterialId: "", yieldQty: "1", yieldUnitId: "", servingSize: "1", notes: "" });
  const menu = useQuery<MenuPick[]>(can("menu.view") && outletId ? "/api/menu" : null, { outletId: outletId ?? undefined });
  const materials = useMaterials(can("master.view"));
  const units = useUnits(can("master.view"));
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const menuItem = d.outputType === "MENU_ITEM";
  return (
    <FormDialog open onClose={onClose} title="New recipe" size="lg" submitLabel="Create draft"
      description="Creates version 1 as a DRAFT. Add lines, then approve it to use it for consumption and costing."
      onSubmit={() => api<{ recipe: { id: string } }>("/api/recipes", {
        method: "POST",
        body: {
          name: d.name.trim(), outputType: d.outputType, ...(menuItem ? { menuItemId: d.menuItemId } : { outputMaterialId: d.outputMaterialId }),
          yieldQty: Number(d.yieldQty), yieldUnitId: opt(d.yieldUnitId), servingSize: Number(d.servingSize), notes: opt(d.notes),
        },
      })} onDone={(r) => onDone(r.recipe.id)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" required><Input value={d.name} onChange={set("name")} required maxLength={120} /></Field>
        <Field label="Produces" name="outputType" required>
          <Select value={d.outputType} onChange={set("outputType")}>{RecipeOutputType.values.map((t) => <option key={t} value={t}>{t === "MENU_ITEM" ? "A menu item" : "A sub-recipe (stockable material)"}</option>)}</Select>
        </Field>
      </div>
      {menuItem ? (
        <Field label="Menu item" name="menuItemId" required hint={!can("menu.view") ? "Choosing a menu item needs menu access." : "Each menu item has at most one recipe; new versions replace old ones."}>
          <Select value={d.menuItemId} onChange={set("menuItemId")} required>
            <option value="">Select menu item…</option>
            {(menu.data ?? []).filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
      ) : (
        <Field label="Output material" name="outputMaterialId" required hint={!can("master.view") ? "Choosing a material needs master-data access." : "The semi-finished material production batches will stock."}>
          <MaterialSelect materials={materials.items} value={d.outputMaterialId} onChange={(id) => setD({ ...d, outputMaterialId: id })} required aria-label="Output material" />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Yield qty" name="yieldQty" required><Input type="number" inputMode="decimal" step="any" min="0" required value={d.yieldQty} onChange={set("yieldQty")} /></Field>
        <Field label="Yield unit" name="yieldUnitId"><UnitSelect units={units.data} value={d.yieldUnitId} onChange={(v) => setD({ ...d, yieldUnitId: v })} empty="—" /></Field>
        <Field label="Serving size" name="servingSize" required><Input type="number" inputMode="decimal" step="any" min="0" required value={d.servingSize} onChange={set("servingSize")} /></Field>
      </div>
      <Field label="Notes" name="notes"><Textarea value={d.notes} onChange={set("notes")} maxLength={2000} /></Field>
    </FormDialog>
  );
}

function UnitSelect({ units, value, onChange, empty, id, label }: { units: UnitRow[] | undefined; value: string; onChange: (v: string) => void; empty: string; id?: string; label?: string }) {
  return (
    <Select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {(units ?? []).filter((u) => u.active || u.id === value).map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}
    </Select>
  );
}

export function RecipesScreen() {
  const router = useRouter();
  const { manage } = useRecipeAuthority();
  const [outputType, setOutputType] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const list = usePaged<RecipeListRow>("/api/recipes", { outputType: outputType || undefined, search: search || undefined }, 25, { shape: "array" });
  return (
    <>
      <PageHeader title="Recipes" subtitle="Versioned recipes for menu items and sub-recipes; approved versions drive consumption and plate cost"
        actions={manage && <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> New recipe</Button>} />
      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search recipe name…" />
        <SelectFilter label="Produces" value={outputType} onChange={setOutputType} options={RecipeOutputType.values.map((v) => ({ value: v, label: v === "MENU_ITEM" ? "Menu item" : "Sub-recipe" }))} />
      </FilterBar>
      <DataTable label="Recipes" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload}
        empty={search || outputType ? "No recipes match" : "No recipes yet"} onRowClick={(r) => router.push(`/recipes/${r.id}`)}
        columns={[
          { key: "n", header: "Recipe", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
          { key: "t", header: "Produces", cell: (r) => (r.outputType === "MENU_ITEM" ? r.menuItem?.name ?? "Menu item" : <Badge>Sub-recipe</Badge>) },
          { key: "v", header: "Latest version", cell: (r) => (latest(r) ? <span className="inline-flex items-center gap-1.5">v{latest(r)!.version} <StatusBadge status={latest(r)!.status} /></span> : "—") },
          { key: "a", header: "Approved versions", numeric: true, cell: (r) => approvedCount(r) || <span className="text-bad-500">None</span> },
          { key: "s", header: "Status", cell: (r) => <ActiveBadge active={r.active} /> },
        ]} />
      <Pager {...list} />
      {creating && <CreateRecipeDialog onClose={() => setCreating(false)} onDone={(id) => router.push(`/recipes/${id}`)} />}
    </>
  );
}

// ============================================================
// Detail
// ============================================================

/** yyyy-MM-ddTHH:mm in the browser zone, for <input type="datetime-local">. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditVersionDialog({ version, units, onClose, onDone }: { version: RecipeVersion; units: UnitRow[] | undefined; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState({ yieldQty: String(toNumber(version.yieldQty)), yieldUnitId: version.yieldUnitId ?? "", servingSize: String(toNumber(version.servingSize)), effectiveFrom: toLocalInput(version.effectiveFrom), notes: version.notes ?? "" });
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  return (
    <FormDialog open onClose={onClose} title={`Edit draft v${version.version}`} submitLabel="Save draft"
      onSubmit={() => api(`/api/recipes/versions/${version.id}`, {
        method: "PATCH",
        body: { yieldQty: Number(d.yieldQty), yieldUnitId: opt(d.yieldUnitId), servingSize: Number(d.servingSize), effectiveFrom: d.effectiveFrom ? new Date(d.effectiveFrom).toISOString() : undefined, notes: opt(d.notes) },
      })} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Yield qty" name="yieldQty" required><Input type="number" inputMode="decimal" step="any" min="0" required value={d.yieldQty} onChange={set("yieldQty")} /></Field>
        <Field label="Yield unit" name="yieldUnitId"><UnitSelect units={units} value={d.yieldUnitId} onChange={(v) => setD({ ...d, yieldUnitId: v })} empty={version.yieldUnit ?? "—"} /></Field>
        <Field label="Serving size" name="servingSize" required><Input type="number" inputMode="decimal" step="any" min="0" required value={d.servingSize} onChange={set("servingSize")} /></Field>
      </div>
      <Field label="Effective from" name="effectiveFrom" hint="Once approved, this version is used from this moment (the latest approved version in effect wins)."><Input type="datetime-local" value={d.effectiveFrom} onChange={set("effectiveFrom")} /></Field>
      <Field label="Notes" name="notes"><Textarea value={d.notes} onChange={set("notes")} maxLength={2000} /></Field>
    </FormDialog>
  );
}

function NewVersionDialog({ recipe, onClose, onDone }: { recipe: Recipe; onClose: () => void; onDone: (versionId: string) => void }) {
  const [copyFrom, setCopyFrom] = useState(recipe.versions[0]?.id ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <FormDialog open onClose={onClose} title="New version" submitLabel="Create draft" description="Starts the next version as a DRAFT with the lines and yield of the version you copy."
      onSubmit={() => api<{ id: string }>(`/api/recipes/${recipe.id}/versions`, { method: "POST", body: { copyFromVersionId: opt(copyFrom), effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined, notes: opt(notes) } })}
      onDone={(v) => onDone(v.id)}>
      <Field label="Copy from" name="copyFromVersionId">
        <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          {recipe.versions.map((v) => <option key={v.id} value={v.id}>v{v.version} — {humanize(v.status)}</option>)}
        </Select>
      </Field>
      <Field label="Effective from" name="effectiveFrom" hint="Optional; defaults to now"><Input type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
    </FormDialog>
  );
}

function AddLineDialog({ recipe, version, units, onClose, onDone }: { recipe: Recipe; version: RecipeVersion; units: UnitRow[] | undefined; onClose: () => void; onDone: () => void }) {
  const { can } = useShell();
  const [d, setD] = useState({ componentType: "MATERIAL", materialId: "", subRecipeId: "", qty: "", unitId: "", wastagePct: "0" });
  const materials = useMaterials(can("master.view"));
  const subs = useQuery<RecipeListRow[]>(d.componentType === "SUB_RECIPE" ? "/api/recipes" : null, { outputType: "SUB_RECIPE", take: 500 });
  const material = materials.byId.get(d.materialId);
  const isMaterial = d.componentType === "MATERIAL";
  return (
    <FormDialog open onClose={onClose} title={`Add line to v${version.version}`} submitLabel="Add line"
      description="Quantities are per the version's yield. Units other than the material's base unit need a unit conversion."
      onSubmit={() => api(`/api/recipes/versions/${version.id}/lines`, {
        method: "POST",
        body: isMaterial
          ? { componentType: "MATERIAL", materialId: d.materialId, qty: Number(d.qty), unitId: opt(d.unitId), wastagePct: Number(d.wastagePct || 0) }
          : { componentType: "SUB_RECIPE", subRecipeId: d.subRecipeId, qty: Number(d.qty), wastagePct: Number(d.wastagePct || 0) },
      })} onDone={onDone}>
      <Field label="Component" name="componentType">
        <Select value={d.componentType} onChange={(e) => setD({ ...d, componentType: e.target.value })}>
          {RecipeComponentType.values.map((t) => <option key={t} value={t}>{t === "MATERIAL" ? "Raw material" : "Sub-recipe"}</option>)}
        </Select>
      </Field>
      {isMaterial ? (
        <Field label="Material" name="materialId" required hint={!can("master.view") ? "Choosing materials needs master-data access." : undefined}>
          <MaterialSelect materials={materials.items} value={d.materialId} onChange={(id) => setD({ ...d, materialId: id, unitId: "" })} required aria-label="Material" />
        </Field>
      ) : (
        <Field label="Sub-recipe" name="subRecipeId" required hint="Must have an approved version before this version can be approved; cycles are rejected.">
          <Select value={d.subRecipeId} onChange={(e) => setD({ ...d, subRecipeId: e.target.value })} required>
            <option value="">Select sub-recipe…</option>
            {(subs.data ?? []).filter((r) => r.id !== recipe.id && r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Quantity" name="qty" required><Input type="number" inputMode="decimal" step="any" min="0" required value={d.qty} onChange={(e) => setD({ ...d, qty: e.target.value })} /></Field>
        {isMaterial && <Field label="Unit" name="unitId"><UnitSelect units={units} value={d.unitId} onChange={(v) => setD({ ...d, unitId: v })} empty={material?.baseUnit?.code ? `${material.baseUnit.code} (base)` : "Base unit"} /></Field>}
        <Field label="Wastage %" name="wastagePct"><Input type="number" inputMode="decimal" step="any" min="0" max="100" value={d.wastagePct} onChange={(e) => setD({ ...d, wastagePct: e.target.value })} /></Field>
      </div>
    </FormDialog>
  );
}

function CostCard({ version, outletId, outletName }: { version: RecipeVersion; outletId: string; outletName: string }) {
  const [qty, setQty] = useState("");
  const [applied, setApplied] = useState<number | undefined>(undefined);
  useEffect(() => { setQty(""); setApplied(undefined); }, [version.id]);
  const cost = useQuery<Cost>(`/api/recipes/versions/${version.id}/cost`, { outletId, quantity: applied, _l: version.lines.length });
  const yieldLabel = `${formatPrecise(version.yieldQty)}${version.yieldUnit ? ` ${version.yieldUnit}` : ""}`;
  return (
    <Card title={`Cost at ${outletName}`} className="mb-4"
      actions={
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(optNum(qty)); }}>
          <label className="flex flex-col gap-0.5 text-xs text-ink-500"><span>Quantity</span><Input type="number" inputMode="decimal" step="any" min="0" className="w-28" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={String(toNumber(version.yieldQty))} aria-label="Cost quantity" /></label>
          <Button size="sm" type="submit">Recalculate</Button>
        </form>
      }>
      {cost.loading && !cost.data ? <LoadingState /> : cost.error ? <ErrorState error={cost.error} onRetry={cost.reload} compact /> : cost.data ? (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label={`Total for ${applied !== undefined ? formatPrecise(applied) : yieldLabel}`} value={formatMoney(cost.data.total)} hint="Raw materials × weighted average cost at this outlet" />
            <Stat label="Materials" value={cost.data.lines.length} hint="After exploding sub-recipes" />
            <Stat label="Unpriced materials" value={cost.data.lines.filter((l) => !l.unitCost).length} tone={cost.data.lines.some((l) => !l.unitCost) ? "bad" : undefined} hint="No purchase cost at this outlet yet" />
          </div>
          <DataTable label="Cost breakdown" rows={cost.data.lines} rowKey={(l) => l.materialId} empty="No material lines"
            columns={[
              { key: "m", header: "Material", cell: (l) => <span>{l.name ?? l.materialId}{l.sku && <span className="text-ink-500"> ({l.sku})</span>}</span> },
              { key: "q", header: "Qty (base unit)", numeric: true, cell: (l) => `${formatPrecise(l.quantity)} ${l.unit ?? ""}` },
              { key: "u", header: "Unit cost", numeric: true, cell: (l) => (l.unitCost ? formatMoney(l.unitCost) : <Badge tone="warn">No cost</Badge>) },
              { key: "c", header: "Cost", numeric: true, cell: (l) => formatMoney(l.cost) },
            ]} />
        </>
      ) : null}
    </Card>
  );
}

export function RecipeDetail({ id }: { id: string }) {
  const { outletId, outlet, can } = useShell();
  const { manage, approve } = useRecipeAuthority();
  const q = useQuery<Recipe>(`/api/recipes/${id}`);
  const units = useUnits(manage && can("master.view"));
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "edit" | "new" | "line">(null);
  if (q.loading && !q.data) return <LoadingState />;
  if (q.error) return <><PageHeader title="Recipe" back={{ href: "/recipes", label: "Recipes" }} /><ErrorState error={q.error} onRetry={q.reload} /></>;
  if (!q.data) return null;
  const r = q.data;
  const v = r.versions.find((x) => x.id === selected) ?? r.versions[0];
  const hasDraft = r.versions.some((x) => x.status === "DRAFT");
  const draft = v?.status === "DRAFT";
  const tz = outlet?.timezone;
  return (
    <>
      <PageHeader title={r.name} badge={<><Badge>{r.outputType === "MENU_ITEM" ? "Menu item" : "Sub-recipe"}</Badge><ActiveBadge active={r.active} /></>} back={{ href: "/recipes", label: "Recipes" }}
        subtitle={r.menuItem ? <>For <Link className="text-brand-600 hover:underline" href={`/menu/items/${r.menuItem.id}`}>{r.menuItem.name}</Link> ({formatMoney(r.menuItem.price)})</> : r.outputMaterial ? `Produces ${r.outputMaterial.name} (${r.outputMaterial.sku})${r.outputMaterial.unit ? ` in ${r.outputMaterial.unit}` : ""}` : undefined}
        actions={manage && !hasDraft && <Button onClick={() => setDialog("new")}><Icon name="plus" /> New version</Button>} />

      <Card title="Version history" className="mb-4">
        <DataTable label="Versions" rows={r.versions} rowKey={(x) => x.id} onRowClick={(x) => setSelected(x.id)} empty="No versions"
          columns={[
            { key: "v", header: "Version", cell: (x) => <span className={x.id === v?.id ? "font-semibold text-brand-700" : ""}>v{x.version}{x.id === v?.id && <span className="sr-only"> (selected)</span>}</span> },
            { key: "s", header: "Status", cell: (x) => <StatusBadge status={x.status} /> },
            { key: "e", header: "Effective from", cell: (x) => formatDateTime(x.effectiveFrom, tz) },
            { key: "y", header: "Yield", numeric: true, cell: (x) => `${formatPrecise(x.yieldQty)} ${x.yieldUnit ?? ""}` },
            { key: "l", header: "Lines", numeric: true, cell: (x) => x.lines.length },
            { key: "a", header: "Approved", cell: (x) => (x.approvedAt ? formatDate(x.approvedAt, tz) : "—") },
          ]} />
      </Card>

      {v && (
        <>
          <Card className="mb-4"
            title={<span className="flex items-center gap-2">Version {v.version} <StatusBadge status={v.status} /></span>}
            actions={
              <TransitionBar status={v.status as RecipeStatus} table={RECIPE_VERSION_TRANSITIONS} onDone={q.reload}
                specs={approve ? {
                  APPROVED: { label: "Approve", permission: "recipe.approve", variant: "success", action: () => api(`/api/recipes/versions/${v.id}/approve`, { method: "POST" }), success: `Version ${v.version} approved`,
                    confirm: { title: `Approve version ${v.version}?`, message: "The version becomes immutable and is used for consumption and costing from its effective date. Sub-recipes must already have an approved version, and every unit must convert." } },
                  ARCHIVED: { label: v.status === "DRAFT" ? "Discard draft" : "Archive", permission: "recipe.approve", variant: "danger", action: () => api(`/api/recipes/versions/${v.id}/archive`, { method: "POST" }), success: `Version ${v.version} archived`,
                    confirm: { title: v.status === "DRAFT" ? `Discard draft v${v.version}?` : `Archive version ${v.version}?`, message: v.status === "DRAFT" ? "The draft is kept as ARCHIVED history and can no longer be edited." : "It stops being used for new consumption. Past consumption keeps referring to it.", danger: true, confirmLabel: v.status === "DRAFT" ? "Discard" : "Archive" } },
                } : {}}
                extra={manage && draft && <Button onClick={() => setDialog("edit")}><Icon name="edit" /> Edit draft</Button>} />
            }>
            <Details cols={4} items={[
              ["Yield", `${formatPrecise(v.yieldQty)} ${v.yieldUnit ?? ""}`], ["Serving size", formatQty(v.servingSize)], ["Effective from", formatDateTime(v.effectiveFrom, tz)],
              ["Approved", v.approvedAt ? formatDateTime(v.approvedAt, tz) : "—"], ["Notes", v.notes],
            ]} />
            {!draft && <p className="mt-2 text-xs text-ink-500">{humanize(v.status)} versions are immutable history. Start a new version to change the recipe.</p>}
          </Card>

          <Card title="Ingredients" className="mb-4" actions={manage && draft && <Button size="sm" onClick={() => setDialog("line")}><Icon name="plus" /> Add line</Button>}>
            <DataTable label="Recipe lines" rows={v.lines} rowKey={(l) => l.id} empty={draft ? "No lines yet — a version needs at least one line to be approved" : "No lines"}
              columns={[
                {
                  key: "c", header: "Component", cell: (l) => l.componentType === "SUB_RECIPE" && l.subRecipeId
                    ? <Link className="text-brand-600 hover:underline" href={`/recipes/${l.subRecipeId}`}>{l.name ?? "Sub-recipe"}</Link>
                    : <span>{l.name ?? l.materialId}{l.sku && <span className="text-ink-500"> ({l.sku})</span>}</span>,
                },
                { key: "t", header: "Type", cell: (l) => (l.componentType === "SUB_RECIPE" ? <Badge tone="info">Sub-recipe</Badge> : "Material") },
                { key: "q", header: "Qty", numeric: true, cell: (l) => `${formatPrecise(l.qty)} ${l.unit ?? ""}` },
                { key: "w", header: "Wastage", numeric: true, cell: (l) => (toNumber(l.wastagePct) ? `${formatQty(l.wastagePct)}%` : "—") },
                {
                  key: "a", header: "", cell: (l) => manage && draft ? (
                    <div className="flex justify-end">
                      <ActionButton size="sm" variant="ghost" aria-label={`Remove ${l.name ?? "line"}`} action={() => api(`/api/recipes/lines/${l.id}`, { method: "DELETE" })} success="Line removed" onDone={q.reload}
                        confirm={{ title: `Remove ${l.name ?? "this line"}?`, message: `It is removed from draft v${v.version} only.`, confirmLabel: "Remove", danger: true }}><Icon name="trash" /></ActionButton>
                    </div>
                  ) : null,
                },
              ]} />
          </Card>

          {outletId && v.lines.length > 0 && <CostCard version={v} outletId={outletId} outletName={outlet?.name ?? "this outlet"} />}
        </>
      )}
      {!v && <EmptyState title="This recipe has no versions" />}

      {dialog === "edit" && v && <EditVersionDialog version={v} units={units.data} onClose={() => setDialog(null)} onDone={q.reload} />}
      {dialog === "new" && <NewVersionDialog recipe={r} onClose={() => setDialog(null)} onDone={(vid) => { setSelected(vid); q.reload(); }} />}
      {dialog === "line" && v && <AddLineDialog recipe={r} version={v} units={units.data} onClose={() => setDialog(null)} onDone={q.reload} />}
    </>
  );
}
