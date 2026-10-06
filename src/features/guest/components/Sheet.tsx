"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { SfIcon } from "@/features/guest/components/SfIcon";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet on phones, centred dialog on larger screens. Modal: focus moves
 * in and is trapped, Escape / backdrop / ✕ close it, focus returns to the
 * control that opened it, and the page behind does not scroll.
 */
export function Sheet({
  title,
  titleExtra,
  description,
  onClose,
  footer,
  media,
  children,
  plain = false,
  labelledBy,
}: {
  title: ReactNode;
  titleExtra?: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  /** Full-bleed banner above the title (item tile). */
  media?: ReactNode;
  children?: ReactNode;
  plain?: boolean;
  /** Accessible name override (defaults to the title). */
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const first = node.querySelector<HTMLElement>("[data-autofocus]") ?? node;
    first.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === node)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="sf-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`sf-sheet${plain ? " sf-sheet-plain" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        {media && <span className="sf-sheet-grab" aria-hidden="true" />}
        <button type="button" className="sf-sheet-close" onClick={onClose} aria-label="Close">
          <SfIcon name="x" />
        </button>
        <div className="sf-sheet-body">
          {media && <div style={{ margin: "0 -20px" }}>{media}</div>}
          <div className="sf-sheet-head">
            <h2 id={titleId}>
              {titleExtra}
              <span>{title}</span>
            </h2>
            {description && <p id={descId}>{description}</p>}
          </div>
          {children}
        </div>
        {footer && <div className="sf-sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
