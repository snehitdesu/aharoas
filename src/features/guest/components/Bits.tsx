import type { ReactNode } from "react";
import { formatMoney } from "@/lib/format";
import { SfIcon } from "@/features/guest/components/SfIcon";

const SMALL = new Set(["and", "with", "the", "of", "a", "an", "&", "for", "it"]);

/** Two-letter monogram for a dish ("Classic Margherita Pizza" → "CM"). */
export function monogram(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, " ")
    .split(/[\s/+-]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter((w) => w && !SMALL.has(w.toLowerCase()) && !/^\d+$/.test(w));
  const letters = words.slice(0, 2).map((w) => w[0]!.toUpperCase());
  return letters.join("") || name.slice(0, 1).toUpperCase();
}

function tone(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 4;
}

/**
 * The menu has no photographs (RESTORA's menu has no image field and none were
 * supplied), so a dish is shown as a monogram tile — never a stock photo that
 * could misrepresent the food.
 */
export function ItemThumb({ name, seed, large = false }: { name: string; seed: string; large?: boolean }) {
  return (
    <div className={`sf-thumb sf-thumb-t${tone(seed)}${large ? " sf-thumb-lg" : ""}`} aria-hidden="true">
      <span>{monogram(name)}</span>
    </div>
  );
}

/** Indian veg / non-veg mark. Shape differs too (dot vs triangle), so it is not colour-only. */
export function VegMark({ veg, labelled = true }: { veg: boolean; labelled?: boolean }) {
  return <span className={`sf-veg ${veg ? "sf-veg-yes" : "sf-veg-no"}`} role={labelled ? "img" : undefined} aria-label={labelled ? (veg ? "Vegetarian" : "Non-vegetarian") : undefined} aria-hidden={labelled ? undefined : true} />;
}

/** Menu price without trailing ".00" (₹110, ₹99.50); bills and totals keep paise. */
export function formatMenuPrice(value: number | string): string {
  const n = Number(value);
  return Number.isInteger(n) ? `₹${n.toLocaleString("en-IN")}` : formatMoney(n);
}

export function Money({ value, className }: { value: number | string; className?: string }) {
  return <span className={`sf-num${className ? ` ${className}` : ""}`}>{formatMoney(value)}</span>;
}

export function Alert({ tone, children, role }: { tone: "info" | "ok" | "bad" | "warn"; children: ReactNode; role?: "alert" | "status" }) {
  const icon = tone === "ok" ? "check" : tone === "bad" || tone === "warn" ? "alert" : "info";
  return (
    <div className={`sf-alert sf-alert-${tone}`} role={role}>
      <SfIcon name={icon} />
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <>
      <span className="sf-spinner" aria-hidden="true" />
      {label && <span className="sf-sr">{label}</span>}
    </>
  );
}

/** Quantity − n + control. */
export function Stepper({ value, onDec, onInc, label, max, light = false, min = 1 }: { value: number; onDec: () => void; onInc: () => void; label: string; max: number; light?: boolean; min?: number }) {
  return (
    <div className={`sf-stepper${light ? " sf-stepper-light" : ""}`} role="group" aria-label={`Quantity of ${label}`}>
      <button type="button" onClick={onDec} aria-label={value <= min ? `Remove ${label}` : `Decrease ${label}`} disabled={value < min}>
        <SfIcon name={value <= min && min === 1 ? "trash" : "minus"} />
      </button>
      <span aria-live="polite" aria-atomic="true">
        {value}
      </span>
      <button type="button" onClick={onInc} aria-label={`Increase ${label}`} disabled={value >= max}>
        <SfIcon name="plus" />
      </button>
    </div>
  );
}
