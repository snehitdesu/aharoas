"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";

type Tone = "ok" | "bad" | "info";
type Toast = { id: number; tone: Tone; message: string };
type ToastApi = { show: (message: string, tone?: Tone) => void };

const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** Lightweight toasts announced to screen readers via aria-live. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const show = useCallback((message: string, tone: Tone = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 7000 : 3500);
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  const tones: Record<Tone, string> = {
    ok: "border-ok-100 bg-white text-ink-900 before:bg-ok-500",
    bad: "border-bad-100 bg-white text-ink-900 before:bg-bad-500",
    info: "border-brand-100 bg-white text-ink-900 before:bg-brand-500",
  };
  const icons: Record<Tone, "check" | "alert" | "bell"> = { ok: "check", bad: "alert", info: "bell" };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "bad" ? "alert" : "status"}
            className={`pointer-events-auto relative flex animate-slide-up items-start gap-2.5 overflow-hidden rounded-lg border py-2.5 pl-4 pr-3 text-sm shadow-pop before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${tones[t.tone]}`}
          >
            <Icon name={icons[t.tone]} className={`mt-0.5 h-4 w-4 shrink-0 ${t.tone === "ok" ? "text-ok-600" : t.tone === "bad" ? "text-bad-600" : "text-brand-600"}`} />
            <span className="leading-snug">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
