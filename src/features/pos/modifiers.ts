/**
 * Modifier selection rules for the POS dialog, mirroring what the server
 * enforces in menu.priceMenuSelection: only active groups/options count, and
 * each group needs between minSelect and maxSelect options. The server is the
 * final authority; this only prevents an obviously invalid submission.
 */
import type { ModifierGroupDTO, MenuItemDTO } from "@/features/pos/types";
import { toNumber } from "@/lib/format";

export type Selection = Record<string, string[]>;

export function activeGroups(item: Pick<MenuItemDTO, "modifierGroups">): ModifierGroupDTO[] {
  return item.modifierGroups.map((g) => g.group).filter((g) => g.active).map((g) => ({ ...g, options: g.options.filter((o) => o.active) }));
}

/** Single-choice groups (max 1) behave like radios; others toggle up to maxSelect. */
export function toggleOption(sel: Selection, group: ModifierGroupDTO, optionId: string): Selection {
  const current = sel[group.id] ?? [];
  if (current.includes(optionId)) {
    return { ...sel, [group.id]: current.filter((id) => id !== optionId) };
  }
  if (group.maxSelect === 1) return { ...sel, [group.id]: [optionId] };
  if (current.length >= group.maxSelect) return sel; // cannot exceed max
  return { ...sel, [group.id]: [...current, optionId] };
}

export function groupRule(g: Pick<ModifierGroupDTO, "minSelect" | "maxSelect">): string {
  if (g.minSelect === 0) return g.maxSelect === 1 ? "Optional · choose 1" : `Optional · up to ${g.maxSelect}`;
  if (g.minSelect === g.maxSelect) return `Required · choose ${g.minSelect}`;
  return `Required · choose ${g.minSelect}–${g.maxSelect}`;
}

export function validateSelection(groups: ModifierGroupDTO[], sel: Selection): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  for (const g of groups) {
    const n = (sel[g.id] ?? []).length;
    if (n < g.minSelect) errors[g.id] = `Choose at least ${g.minSelect}`;
    else if (n > g.maxSelect) errors[g.id] = `Choose at most ${g.maxSelect}`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Selected option ids (in group order), their labels and per-unit price. */
export function summarizeSelection(groups: ModifierGroupDTO[], sel: Selection) {
  const ids: string[] = [];
  const labels: string[] = [];
  let perUnit = 0;
  for (const g of groups) {
    for (const o of g.options) {
      if ((sel[g.id] ?? []).includes(o.id)) {
        ids.push(o.id);
        labels.push(`${g.name}: ${o.name}`);
        perUnit += toNumber(o.priceDelta);
      }
    }
  }
  return { ids, labels, perUnit };
}

/** An item can be added in one tap when it has no variants and no modifier groups. */
export function needsConfiguration(item: Pick<MenuItemDTO, "variants" | "modifierGroups">): boolean {
  return item.variants.some((v) => v.active) || activeGroups(item as MenuItemDTO).length > 0;
}
