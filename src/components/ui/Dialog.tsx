"use client";

import { useEffect, useId, useRef } from "react";
import { Icon } from "@/components/ui/Icon";

/**
 * Accessible modal dialog: role="dialog", aria-modal, labelled by its title,
 * focus moved inside on open and restored on close, Tab trapped, Esc closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  // Callers pass inline handlers; reading the latest one through a ref keeps the
  // focus effect below from re-running (and stealing focus) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    (focusables().find((el) => el.dataset.autofocus !== undefined) ?? focusables()[0] ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-3xl" : "max-w-lg";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} tabIndex={-1} className={`flex max-h-[90vh] w-full ${width} flex-col rounded-lg bg-white shadow-xl outline-none`}>
        <div className="flex items-start justify-between gap-4 border-b border-ink-300 px-5 py-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-ink-900">{title}</h2>
            {description && <p id={descId} className="mt-0.5 text-sm text-ink-500">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-500 hover:bg-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" aria-label="Close dialog">
            <Icon name="x" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-300 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
