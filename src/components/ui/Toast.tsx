"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

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
  const tones: Record<Tone, string> = { ok: "border-green-300 bg-ok-100 text-green-900", bad: "border-red-300 bg-bad-100 text-red-900", info: "border-ink-300 bg-white text-ink-900" };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === "bad" ? "alert" : "status"} className={`pointer-events-auto rounded-md border px-3 py-2 text-sm shadow ${tones[t.tone]}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
