"use client";

/**
 * Menu back office: items (variants, modifier groups, per-outlet price /
 * offered / sold-out), categories and modifier groups.
 *
 * Authority mirrors the menu service: the menu is organization-wide, so
 * structural changes need menu.manage from an org-wide role; an outlet's price
 * / offered / sold-out override needs menu.manage at that outlet only. The UI
 * hides what would be refused; the API decides.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useLocalPage } from "@/lib/hooks/useLocalPage";
import { useShell } from "@/lib/shellContext";
import { formatMoney, formatPct, humanize, toNumber } from "@/lib/format";
import { Station } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Checkbox, Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { ActiveBadge, Card, Details, PageHeader, Stat } from "@/components/ui/Page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { FilterBar, SearchInput, SelectFilter } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";

type Num = string | number;
export type MenuCategory = { id: string; name: string; sortOrder: number; active: boolean };
export type ModifierOption = { id: string; groupId: string; name: string; priceDelta: Num; active: boolean };
export type ModifierGroup = { id: string; name: string; minSelect: number; maxSelect: number; active: boolean; options: ModifierOption[]; itemCount?: number };
export type Variant = { id: string; menuItemId: string; name: string; priceDelta: Num; active: boolean };
export type MenuItem = {
  id: string; name: string; description: string | null; categoryId: string | null; category: { id: string; name: string } | null;
  price: Num; taxPct: Num; station: string; posCode: string | null; isVeg: boolean; active: boolean; soldOut: boolean;
  variants: Variant[]; modifierGroups: Array<{ id: string; groupId: string; group: ModifierGroup }>;
  outletOverrides?: Array<{ price: Num | null; active: boolean; soldOut: boolean }>;
  effectivePrice?: number; offered?: boolean; effectiveSoldOut?: boolean;
};
type Margin = { price: number; cost: number; margin: number; foodCostPct: number; versionId: string };

/** "Required · choose 1", "Optional · up to 3"… from a group's min/max. */
export function ruleText(min: number, max: number): string {
  if (min <= 0) return `Optional · up to ${max}`;
  return min === max ? `Required · choose ${min}` : `Required · choose ${min}–${max}`;
}

/** Structural menu edits: org-wide role with menu.manage (menu service rule). */
function useMenuAuthority() {
  const { can, orgWide } = useShell();
  return { orgManage: can("menu.manage") && orgWide, outletManage: can("menu.manage") };
}

function useMenu(outletId: string | null, categoryId?: string) {
  return useQuery<MenuItem[]>(outletId ? "/api/menu" : null, { outletId: outletId ?? undefined, categoryId: categoryId || undefined });
}
function useCategories() {
  return useQuery<MenuCategory[]>("/api/menu/categories");
}

function VegMark({ veg }: { veg: boolean }) {
  return <span title={veg ? "Veg" : "Non-veg"} aria-label={veg ? "Veg" : "Non-veg"} className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-sm border ${veg ? "border-ok-500 bg-ok-500" : "border-bad-500 bg-bad-500"}`} />;
}

/** Availability at the selected outlet, from the server's effective fields. */
function OutletState({ item }: { item: MenuItem }) {
  if (!item.active) return <Badge>Off menu</Badge>;
  if (item.offered === false) return <Badge tone="warn">Not offered here</Badge>;
  if (item.effectiveSoldOut) return <Badge tone="bad">Sold out</Badge>;
  return <Badge tone="ok">Available</Badge>;
}

// ============================================================
// Item form
// ============================================================

function ItemDialog({ item, categories, onClose, onDone }: { item?: MenuItem; categories: MenuCategory[]; onClose: () => void; onDone: (r: MenuItem) => void }) {
  const [d, setD] = useState({
    name: item?.name ?? "", categoryId: item?.categoryId ?? "", price: item ? String(toNumber(item.price)) : "", taxPct: item ? String(toNumber(item.taxPct)) : "5",
    station: item?.station ?? "KITCHEN", posCode: item?.posCode ?? "", isVeg: item?.isVeg ?? true, description: item?.description ?? "",
  });
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const body = { name: d.name.trim(), categoryId: opt(d.categoryId), price: Number(d.price), taxPct: Number(d.taxPct), station: d.station, posCode: opt(d.posCode), isVeg: d.isVeg, description: opt(d.description) };
  return (
    <FormDialog open onClose={onClose} title={item ? `Edit ${item.name}` : "New menu item"} size="lg" submitLabel={item ? "Save" : "Create item"}
      description="The menu is shared by every outlet; outlets can override price and availability."
      onSubmit={() => (item ? api<MenuItem>(`/api/menu/items/${item.id}`, { method: "PATCH", body }) : api<MenuItem>("/api/menu/items", { method: "POST", body }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" required><Input value={d.name} onChange={set("name")} required maxLength={120} /></Field>
        <Field label="Category" name="categoryId" hint={item?.categoryId ? "An item's category can be changed but not cleared" : undefined}>
          <Select value={d.categoryId} onChange={set("categoryId")}>
            <option value="">{item?.categoryId ? "Keep current" : "Uncategorized"}</option>
            {categories.filter((c) => c.active || c.id === d.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Price (₹)" name="price" required><Input type="number" inputMode="decimal" step="0.01" min="0" required value={d.price} onChange={set("price")} /></Field>
        <Field label="Tax %" name="taxPct" required><Input type="number" inputMode="decimal" step="0.01" min="0" max="28" required value={d.taxPct} onChange={set("taxPct")} /></Field>
        <Field label="Kitchen station" name="station"><Select value={d.station} onChange={set("station")}>{Station.values.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
        <Field label="POS code" name="posCode" hint="External POS item code (unique)"><Input value={d.posCode} onChange={set("posCode")} maxLength={64} /></Field>
      </div>
      <Field label="Description" name="description"><Textarea value={d.description} onChange={set("description")} maxLength={1000} /></Field>
      <Checkbox label="Vegetarian" checked={d.isVeg} onChange={(v) => setD({ ...d, isVeg: v })} name="isVeg" />
    </FormDialog>
  );
}

// ============================================================
// Items list
// ============================================================

const STATUS_FILTERS = [
  { value: "available", label: "Available here" },
  { value: "soldout", label: "Sold out here" },
  { value: "notoffered", label: "Not offered here" },
  { value: "inactive", label: "Off menu" },
];

export function MenuItemsScreen() {
  const router = useRouter();
  const { outletId, outlet } = useShell();
  const { orgManage } = useMenuAuthority();
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const menu = useMenu(outletId, categoryId);
  const cats = useCategories();
  const term = search.toLowerCase();
  const rows = useMemo(
    () =>
      (menu.data ?? [])
        .filter((i) => !term || `${i.name} ${i.posCode ?? ""}`.toLowerCase().includes(term))
        .filter((i) =>
          status === "available" ? i.active && i.offered !== false && !i.effectiveSoldOut
          : status === "soldout" ? i.active && i.offered !== false && i.effectiveSoldOut
          : status === "notoffered" ? i.active && i.offered === false
          : status === "inactive" ? !i.active
          : true
        ),
    [menu.data, term, status]
  );
  const pager = useLocalPage(rows, 50, `${term}|${status}|${categoryId}`);
  return (
    <>
      <PageHeader title="Menu items" subtitle={`Organization menu, with price and availability at ${outlet?.name ?? "this outlet"}`}
        actions={orgManage && <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> New item</Button>} />
      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or POS code…" />
        <SelectFilter label="Category" value={categoryId} onChange={setCategoryId} options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <SelectFilter label="Status" value={status} onChange={setStatus} options={STATUS_FILTERS} />
      </FilterBar>
      <DataTable label="Menu items" rows={pager.items} rowKey={(r) => r.id} loading={menu.loading} error={menu.error} onRetry={menu.reload}
        empty={search || status || categoryId ? "No items match these filters" : "No menu items yet"}
        emptyHint={!search && !status && !categoryId && orgManage ? "Create categories first, then add items." : undefined}
        onRowClick={(r) => router.push(`/menu/items/${r.id}`)}
        columns={[
          { key: "n", header: "Item", cell: (r) => <span className="font-medium text-ink-900"><VegMark veg={r.isVeg} />{r.name}</span> },
          { key: "c", header: "Category", cell: (r) => r.category?.name ?? "—" },
          { key: "s", header: "Station", cell: (r) => humanize(r.station) },
          { key: "p", header: "Menu price", numeric: true, cell: (r) => formatMoney(r.price) },
          { key: "e", header: "Price here", numeric: true, cell: (r) => <span>{formatMoney(r.effectivePrice ?? r.price)}{r.outletOverrides?.[0]?.price != null && <Badge tone="info" className="ml-1">Override</Badge>}</span> },
          { key: "o", header: "Here", cell: (r) => <OutletState item={r} /> },
          { key: "v", header: "Variants", numeric: true, cell: (r) => r.variants.length || "—" },
          { key: "m", header: "Modifiers", numeric: true, cell: (r) => r.modifierGroups.length || "—" },
        ]} />
      <Pager {...pager} />
      {creating && <ItemDialog categories={cats.data ?? []} onClose={() => setCreating(false)} onDone={(r) => router.push(`/menu/items/${r.id}`)} />}
    </>
  );
}

// ============================================================
// Item detail
// ============================================================

function OverridePriceDialog({ item, outletId, outletName, onClose, onDone }: { item: MenuItem; outletId: string; outletName: string; onClose: () => void; onDone: () => void }) {
  const current = item.outletOverrides?.[0]?.price;
  const [price, setPrice] = useState(current != null ? String(toNumber(current)) : "");
  return (
    <FormDialog open onClose={onClose} title={`Price at ${outletName}`} submitLabel="Save price" description={`Menu price is ${formatMoney(item.price)}. Leave empty to use the menu price here.`}
      onSubmit={() => api(`/api/menu/outlets/${outletId}/items/${item.id}`, { method: "POST", body: { price: price.trim() === "" ? null : Number(price) } })} onDone={onDone}>
      <Field label="Outlet price (₹)" name="price"><Input type="number" inputMode="decimal" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={String(toNumber(item.price))} /></Field>
    </FormDialog>
  );
}

function VariantDialog({ item, variant, onClose, onDone }: { item: MenuItem; variant?: Variant; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(variant?.name ?? "");
  const [delta, setDelta] = useState(variant ? String(toNumber(variant.priceDelta)) : "0");
  return (
    <FormDialog open onClose={onClose} title={variant ? `Variant: ${variant.name}` : "Add variant"} submitLabel={variant ? "Save" : "Add variant"}
      description={`Price change relative to the item price (${formatMoney(item.price)}); may be negative.`}
      onSubmit={() => (variant ? api(`/api/menu/variants/${variant.id}`, { method: "PATCH", body: { priceDelta: Number(delta) } }) : api(`/api/menu/items/${item.id}/variants`, { method: "POST", body: { name: name.trim(), priceDelta: Number(delta) } }))} onDone={onDone}>
      <Field label="Name" name="name" required hint={variant ? "Variant names cannot be changed" : "e.g. Half, Full, Large"}><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} disabled={Boolean(variant)} /></Field>
      <Field label="Price change (₹)" name="priceDelta" required><Input type="number" inputMode="decimal" step="0.01" required value={delta} onChange={(e) => setDelta(e.target.value)} /></Field>
    </FormDialog>
  );
}

function AttachGroupDialog({ item, groups, onClose, onDone }: { item: MenuItem; groups: ModifierGroup[]; onClose: () => void; onDone: () => void }) {
  const attached = new Set(item.modifierGroups.map((g) => g.groupId));
  const available = groups.filter((g) => g.active && !attached.has(g.id));
  const [groupId, setGroupId] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Attach modifier group" submitLabel="Attach" onSubmit={() => api(`/api/menu/items/${item.id}/modifier-groups/${groupId}`, { method: "POST" })} onDone={onDone}>
      <Field label="Group" name="groupId" required hint={!available.length ? "All active groups are already attached. Create groups under Modifiers." : undefined}>
        <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} required>
          <option value="">Select group…</option>
          {available.map((g) => <option key={g.id} value={g.id}>{g.name} ({ruleText(g.minSelect, g.maxSelect)})</option>)}
        </Select>
      </Field>
    </FormDialog>
  );
}

function MarginCard({ item, outletId }: { item: MenuItem; outletId: string }) {
  const q = useQuery<Margin>(`/api/recipes/menu-items/${item.id}/margin`, { outletId });
  const noRecipe = q.error instanceof ApiError && q.error.kind === "validation";
  return (
    <Card title="Plate cost (approved recipe in effect)" className="mb-4">
      {q.loading && !q.data ? <LoadingState /> : noRecipe ? (
        <EmptyState title="No approved recipe" hint="Sales of this item are recorded as unmapped for consumption until a recipe version is approved." action={<Link href="/recipes" className="text-sm text-brand-600 hover:underline">Go to recipes →</Link>} />
      ) : q.error ? <ErrorState error={q.error} onRetry={q.reload} compact /> : q.data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Menu price" value={formatMoney(q.data.price)} />
          <Stat label="Recipe cost" value={formatMoney(q.data.cost)} hint="Weighted average cost at this outlet" />
          <Stat label="Margin" value={formatMoney(q.data.margin)} tone={q.data.margin < 0 ? "bad" : undefined} />
          <Stat label="Food cost" value={formatPct(q.data.foodCostPct)} />
        </div>
      ) : null}
    </Card>
  );
}

export function MenuItemDetail({ id }: { id: string }) {
  const { outletId, outlet, can } = useShell();
  const { orgManage, outletManage } = useMenuAuthority();
  const menu = useMenu(outletId);
  const cats = useCategories();
  const groups = useQuery<ModifierGroup[]>("/api/menu/modifier-groups");
  const [dialog, setDialog] = useState<null | "edit" | "price" | "variant" | "attach" | Variant>(null);
  if (menu.error) return <><PageHeader title="Menu item" back={{ href: "/menu", label: "Menu items" }} /><ErrorState error={menu.error} onRetry={menu.reload} /></>;
  if (!menu.data) return <LoadingState />;
  const item = menu.data.find((i) => i.id === id);
  if (!item) return <><PageHeader title="Menu item" back={{ href: "/menu", label: "Menu items" }} /><EmptyState title="Menu item not found" hint="It may belong to another organization or have been removed." /></>;
  const ov = item.outletOverrides?.[0];
  const outletName = outlet?.name ?? "this outlet";
  const setOutlet = (body: object) => api(`/api/menu/outlets/${outletId}/items/${item.id}`, { method: "POST", body });
  const setOrg = (body: object) => api(`/api/menu/items/${item.id}/availability`, { method: "POST", body });
  return (
    <>
      <PageHeader title={<><VegMark veg={item.isVeg} />{item.name}</>} badge={<ActiveBadge active={item.active} />} subtitle={item.category?.name ?? "Uncategorized"} back={{ href: "/menu", label: "Menu items" }}
        actions={orgManage && (
          <>
            <Button onClick={() => setDialog("edit")}><Icon name="edit" /> Edit</Button>
            <ActionButton variant={item.soldOut ? "success" : "secondary"} action={() => setOrg({ soldOut: !item.soldOut })} success={item.soldOut ? "Back in stock everywhere" : "Marked sold out everywhere"} onDone={menu.reload}
              confirm={item.soldOut ? undefined : { title: `Mark ${item.name} sold out everywhere?`, message: "Every outlet stops selling it until it is marked back in stock. To 86 it at one outlet only, use the outlet controls below." }}>
              {item.soldOut ? "Back in stock (all outlets)" : "Sold out (all outlets)"}
            </ActionButton>
            <ActionButton variant={item.active ? "danger" : "success"} action={() => setOrg({ active: !item.active })} success={item.active ? "Removed from the menu" : "Back on the menu"} onDone={menu.reload}
              confirm={item.active ? { title: `Take ${item.name} off the menu?`, message: "It disappears from the POS at every outlet. History and reports are kept.", danger: true, confirmLabel: "Take off menu" } : undefined}>
              {item.active ? "Take off menu" : "Put on menu"}
            </ActionButton>
          </>
        )} />
      <Card className="mb-4">
        <Details cols={4} items={[
          ["Menu price", formatMoney(item.price)], ["Tax", formatPct(item.taxPct)], ["Station", humanize(item.station)], ["POS code", item.posCode],
          ["Type", item.isVeg ? "Veg" : "Non-veg"], ["Sold out (all outlets)", item.soldOut ? "Yes" : "No"], ["Description", item.description],
        ]} />
      </Card>

      <Card title={`At ${outletName}`} className="mb-4"
        actions={outletManage && item.active && (
          <>
            <Button size="sm" onClick={() => setDialog("price")}>Set price</Button>
            <ActionButton size="sm" variant={ov?.soldOut ? "success" : "secondary"} action={() => setOutlet({ soldOut: !ov?.soldOut })} success={ov?.soldOut ? "Back in stock here" : "Sold out here"} onDone={menu.reload}>{ov?.soldOut ? "Back in stock here" : "Sold out here"}</ActionButton>
            <ActionButton size="sm" variant={ov?.active === false ? "success" : "danger"} action={() => setOutlet({ active: ov?.active === false })} success={ov?.active === false ? "Offered here again" : "No longer offered here"} onDone={menu.reload}
              confirm={ov?.active === false ? undefined : { title: `Stop offering ${item.name} at ${outletName}?`, message: "Other outlets are not affected.", confirmLabel: "Stop offering", danger: true }}>
              {ov?.active === false ? "Offer here" : "Stop offering here"}
            </ActionButton>
          </>
        )}>
        <Details cols={4} items={[
          ["Price here", <span key="p">{formatMoney(item.effectivePrice ?? item.price)}{ov?.price != null && <Badge tone="info" className="ml-1">Override</Badge>}</span>],
          ["Availability", <OutletState key="s" item={item} />],
          ["Offered here", item.offered === false ? "No" : "Yes"],
          ["Sold out here", ov?.soldOut ? "Yes" : "No"],
        ]} />
        {!item.active && <p className="mt-2 text-xs text-ink-500">This item is off the menu for every outlet; outlet overrides apply once it is back on the menu.</p>}
      </Card>

      {can("recipe.view") && outletId && <MarginCard item={item} outletId={outletId} />}

      <Card title="Variants" className="mb-4" actions={orgManage && <Button size="sm" onClick={() => setDialog("variant")}><Icon name="plus" /> Add variant</Button>}>
        {item.variants.length === 0 ? <p className="text-sm text-ink-500">No variants — the item is sold at one price.</p> : (
          <DataTable label="Variants" rows={item.variants} rowKey={(v) => v.id}
            columns={[
              { key: "n", header: "Variant", cell: (v) => <span className="font-medium text-ink-900">{v.name}</span> },
              { key: "d", header: "Price change", numeric: true, cell: (v) => `${toNumber(v.priceDelta) >= 0 ? "+" : "−"}${formatMoney(Math.abs(toNumber(v.priceDelta)))}` },
              { key: "s", header: "Status", cell: (v) => <ActiveBadge active={v.active} /> },
              {
                key: "a", header: "", cell: (v) => orgManage ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => setDialog(v)}>Edit</Button>
                    <ActionButton size="sm" variant={v.active ? "danger" : "success"} action={() => api(`/api/menu/variants/${v.id}`, { method: "PATCH", body: { active: !v.active } })} success={v.active ? "Variant deactivated" : "Variant activated"} onDone={menu.reload}>{v.active ? "Deactivate" : "Activate"}</ActionButton>
                  </div>
                ) : null,
              },
            ]} />
        )}
      </Card>

      <Card title="Modifier groups" actions={orgManage && <Button size="sm" onClick={() => setDialog("attach")}><Icon name="plus" /> Attach group</Button>}>
        {item.modifierGroups.length === 0 ? <p className="text-sm text-ink-500">No modifier groups attached.</p> : (
          <DataTable label="Attached modifier groups" rows={item.modifierGroups} rowKey={(l) => l.id}
            columns={[
              { key: "n", header: "Group", cell: (l) => <span className="font-medium text-ink-900">{l.group.name}</span> },
              { key: "r", header: "Rule", cell: (l) => ruleText(l.group.minSelect, l.group.maxSelect) },
              { key: "o", header: "Options", cell: (l) => l.group.options.filter((o) => o.active).map((o) => o.name).join(", ") || "—" },
              { key: "s", header: "Status", cell: (l) => <ActiveBadge active={l.group.active} /> },
              {
                key: "a", header: "", cell: (l) => orgManage ? (
                  <div className="flex justify-end">
                    <ActionButton size="sm" variant="danger" action={() => api(`/api/menu/items/${item.id}/modifier-groups/${l.groupId}`, { method: "DELETE" })} success="Group detached" onDone={menu.reload}
                      confirm={{ title: `Detach ${l.group.name}?`, message: `${item.name} will no longer offer these options. The group itself is kept.`, confirmLabel: "Detach", danger: true }}>Detach</ActionButton>
                  </div>
                ) : null,
              },
            ]} />
        )}
      </Card>

      {dialog === "edit" && <ItemDialog item={item} categories={cats.data ?? []} onClose={() => setDialog(null)} onDone={() => menu.reload()} />}
      {dialog === "price" && outletId && <OverridePriceDialog item={item} outletId={outletId} outletName={outletName} onClose={() => setDialog(null)} onDone={menu.reload} />}
      {dialog === "variant" && <VariantDialog item={item} onClose={() => setDialog(null)} onDone={menu.reload} />}
      {dialog && typeof dialog === "object" && <VariantDialog item={item} variant={dialog} onClose={() => setDialog(null)} onDone={menu.reload} />}
      {dialog === "attach" && <AttachGroupDialog item={item} groups={groups.data ?? []} onClose={() => setDialog(null)} onDone={menu.reload} />}
    </>
  );
}

// ============================================================
// Categories
// ============================================================

function CategoryDialog({ cat, onClose, onDone }: { cat?: MenuCategory; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(cat?.name ?? "");
  const [sortOrder, setSortOrder] = useState(String(cat?.sortOrder ?? 0));
  const body = { name: name.trim(), sortOrder: Number(sortOrder) };
  return (
    <FormDialog open onClose={onClose} title={cat ? `Edit ${cat.name}` : "New category"} submitLabel={cat ? "Save" : "Create"}
      onSubmit={() => (cat ? api(`/api/menu/categories/${cat.id}`, { method: "PATCH", body }) : api("/api/menu/categories", { method: "POST", body }))} onDone={onDone}>
      <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
      <Field label="Sort order" name="sortOrder" required hint="Lower numbers appear first on the POS"><Input type="number" step="1" required value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></Field>
    </FormDialog>
  );
}

export function MenuCategoriesScreen() {
  const { orgManage } = useMenuAuthority();
  const cats = useCategories();
  const [editing, setEditing] = useState<MenuCategory | "new" | null>(null);
  return (
    <>
      <PageHeader title="Menu categories" subtitle="Sections of the menu, in POS order" actions={orgManage && <Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" /> New category</Button>} />
      <DataTable label="Menu categories" rows={cats.data ?? []} rowKey={(c) => c.id} loading={cats.loading} error={cats.error} onRetry={cats.reload} empty="No categories yet"
        columns={[
          { key: "o", header: "Order", numeric: true, cell: (c) => c.sortOrder },
          { key: "n", header: "Name", cell: (c) => <span className="font-medium text-ink-900">{c.name}</span> },
          { key: "s", header: "Status", cell: (c) => <ActiveBadge active={c.active} /> },
          {
            key: "a", header: "", cell: (c) => orgManage ? (
              <div className="flex justify-end gap-1">
                <Button size="sm" onClick={() => setEditing(c)}>Edit</Button>
                <ActionButton size="sm" variant={c.active ? "danger" : "success"} action={() => api(`/api/menu/categories/${c.id}`, { method: "PATCH", body: { active: !c.active } })} success={c.active ? "Category deactivated" : "Category activated"} onDone={cats.reload}>{c.active ? "Deactivate" : "Activate"}</ActionButton>
              </div>
            ) : null,
          },
        ]} />
      {editing && <CategoryDialog cat={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onDone={cats.reload} />}
    </>
  );
}

// ============================================================
// Modifier groups
// ============================================================

function GroupDialog({ group, onClose, onDone }: { group?: ModifierGroup; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [min, setMin] = useState(String(group?.minSelect ?? 0));
  const [max, setMax] = useState(String(group?.maxSelect ?? 1));
  const minN = Number(min);
  const maxN = Number(max);
  const valid = Number.isInteger(minN) && Number.isInteger(maxN) && minN >= 0 && maxN >= 1 && minN <= maxN;
  return (
    <FormDialog open onClose={onClose} title={group ? `Edit ${group.name}` : "New modifier group"} submitLabel={group ? "Save" : "Create group"}
      onSubmit={() => {
        if (!valid) return Promise.reject(new Error("Minimum must be between 0 and the maximum, and the maximum at least 1."));
        const body = { name: name.trim(), minSelect: minN, maxSelect: maxN };
        return group ? api(`/api/menu/modifier-groups/${group.id}`, { method: "PATCH", body }) : api("/api/menu/modifier-groups", { method: "POST", body });
      }} onDone={onDone}>
      <Field label="Name" name="name" required hint="e.g. Spice level, Add-ons"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Minimum choices" name="minSelect" required hint="0 = optional"><Input type="number" step="1" min="0" required value={min} onChange={(e) => setMin(e.target.value)} /></Field>
        <Field label="Maximum choices" name="maxSelect" required><Input type="number" step="1" min="1" required value={max} onChange={(e) => setMax(e.target.value)} /></Field>
      </div>
      <p className="text-sm text-ink-500" aria-live="polite">{valid ? ruleText(minN, maxN) : "Minimum cannot exceed maximum."}</p>
    </FormDialog>
  );
}

function OptionDialog({ group, option, onClose, onDone }: { group: ModifierGroup; option?: ModifierOption; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(option?.name ?? "");
  const [delta, setDelta] = useState(option ? String(toNumber(option.priceDelta)) : "0");
  return (
    <FormDialog open onClose={onClose} title={option ? `Option: ${option.name}` : `Add option to ${group.name}`} submitLabel={option ? "Save" : "Add option"}
      onSubmit={() => (option ? api(`/api/menu/modifier-options/${option.id}`, { method: "PATCH", body: { priceDelta: Number(delta) } }) : api(`/api/menu/modifier-groups/${group.id}/options`, { method: "POST", body: { name: name.trim(), priceDelta: Number(delta) } }))} onDone={onDone}>
      <Field label="Name" name="name" required hint={option ? "Option names cannot be changed" : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} disabled={Boolean(option)} /></Field>
      <Field label="Extra price (₹)" name="priceDelta" required hint="Added to the item price; 0 for free options"><Input type="number" inputMode="decimal" step="0.01" min="0" required value={delta} onChange={(e) => setDelta(e.target.value)} /></Field>
    </FormDialog>
  );
}

export function ModifiersScreen() {
  const { orgManage } = useMenuAuthority();
  const groups = useQuery<ModifierGroup[]>("/api/menu/modifier-groups");
  const [dialog, setDialog] = useState<null | { kind: "group"; group?: ModifierGroup } | { kind: "option"; group: ModifierGroup; option?: ModifierOption }>(null);
  return (
    <>
      <PageHeader title="Modifiers" subtitle="Option groups attached to menu items (spice level, add-ons…) with selection rules" actions={orgManage && <Button variant="primary" onClick={() => setDialog({ kind: "group" })}><Icon name="plus" /> New group</Button>} />
      {groups.error ? <ErrorState error={groups.error} onRetry={groups.reload} /> : !groups.data ? <LoadingState /> : groups.data.length === 0 ? <EmptyState title="No modifier groups yet" /> : (
        <div className="flex flex-col gap-4">
          {groups.data.map((g) => (
            <Card key={g.id}
              title={<span className="flex flex-wrap items-center gap-2">{g.name} <ActiveBadge active={g.active} /> <Badge tone={g.minSelect > 0 ? "warn" : "neutral"}>{ruleText(g.minSelect, g.maxSelect)}</Badge> <span className="text-xs font-normal text-ink-500">Used by {g.itemCount ?? 0} item{g.itemCount === 1 ? "" : "s"}</span></span>}
              actions={orgManage && (
                <>
                  <Button size="sm" onClick={() => setDialog({ kind: "option", group: g })}><Icon name="plus" /> Option</Button>
                  <Button size="sm" onClick={() => setDialog({ kind: "group", group: g })}>Edit</Button>
                  <ActionButton size="sm" variant={g.active ? "danger" : "success"} action={() => api(`/api/menu/modifier-groups/${g.id}`, { method: "PATCH", body: { active: !g.active } })} success={g.active ? "Group deactivated" : "Group activated"} onDone={groups.reload}
                    confirm={g.active ? { title: `Deactivate ${g.name}?`, message: "Items stop offering these options (and stop requiring a choice). It can be reactivated.", danger: true, confirmLabel: "Deactivate" } : undefined}>
                    {g.active ? "Deactivate" : "Activate"}
                  </ActionButton>
                </>
              )}>
              {g.options.length === 0 ? <p className="text-sm text-ink-500">No options yet{g.minSelect > 0 ? " — a required group with no options blocks ordering of its items" : ""}.</p> : (
                <DataTable label={`${g.name} options`} rows={g.options} rowKey={(o) => o.id}
                  columns={[
                    { key: "n", header: "Option", cell: (o) => <span className="font-medium text-ink-900">{o.name}</span> },
                    { key: "p", header: "Extra price", numeric: true, cell: (o) => (toNumber(o.priceDelta) ? `+${formatMoney(o.priceDelta)}` : "Free") },
                    { key: "s", header: "Status", cell: (o) => <ActiveBadge active={o.active} /> },
                    {
                      key: "a", header: "", cell: (o) => orgManage ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" onClick={() => setDialog({ kind: "option", group: g, option: o })}>Edit</Button>
                          <ActionButton size="sm" variant={o.active ? "danger" : "success"} action={() => api(`/api/menu/modifier-options/${o.id}`, { method: "PATCH", body: { active: !o.active } })} success={o.active ? "Option deactivated" : "Option activated"} onDone={groups.reload}>{o.active ? "Deactivate" : "Activate"}</ActionButton>
                        </div>
                      ) : null,
                    },
                  ]} />
              )}
            </Card>
          ))}
        </div>
      )}
      {dialog?.kind === "group" && <GroupDialog group={dialog.group} onClose={() => setDialog(null)} onDone={groups.reload} />}
      {dialog?.kind === "option" && <OptionDialog group={dialog.group} option={dialog.option} onClose={() => setDialog(null)} onDone={groups.reload} />}
    </>
  );
}
