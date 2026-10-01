"use client";

import { ApiError, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-ink-500">
      <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />
      {label}
    </span>
  );
}

/** Loading placeholder block. Compose several to sketch a page while it loads. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <span aria-hidden className={`skeleton block rounded-md ${className}`} />;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center p-6">
      <Spinner label={label} />
    </div>
  );
}

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: string; action?: React.ReactNode; icon?: IconName }) {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-1.5 p-8 text-center">
      {icon && (
        <span className="mb-1 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-500">
          <Icon name={icon} className="h-5 w-5" />
        </span>
      )}
      <p className="text-sm font-semibold text-ink-800">{title}</p>
      {hint && <p className="max-w-sm text-sm text-ink-500">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Error state that distinguishes session expiry, missing permission and network failure. */
export function ErrorState({ error, onRetry, compact = false }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const kind = error instanceof ApiError ? error.kind : "unknown";
  const title =
    kind === "unauthorized" ? "Session ended" : kind === "forbidden" ? "Not allowed" : kind === "network" ? "Can't reach the server" : "Something went wrong";
  return (
    <div role="alert" className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? "p-3" : "min-h-32 p-6"}`}>
      <Icon name="alert" className="h-5 w-5 text-bad-500" />
      <p className="text-sm font-medium text-ink-900">{title}</p>
      <p className="max-w-md text-sm text-ink-500">{describeError(error)}</p>
      <div className="mt-1 flex gap-2">
        {kind === "unauthorized" ? (
          <a href={`/login?next=${typeof window !== "undefined" ? encodeURIComponent(window.location.pathname) : "/"}`} className="text-sm font-medium text-brand-600 underline">
            Sign in again
          </a>
        ) : (
          onRetry && kind !== "forbidden" && (
            <Button size="sm" onClick={onRetry}>
              <Icon name="refresh" /> Retry
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/** Full-page gate when the user lacks the permission for a whole surface. */
export function ForbiddenPage({ title, reason }: { title: string; reason: string }) {
  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <div role="alert" className="max-w-md rounded-xl border border-ink-200 bg-white p-6 text-center shadow-card">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-ink-500">{reason}</p>
        <a href="/dashboard" className="mt-4 inline-block text-sm font-medium text-brand-600 underline">
          Back to dashboard
        </a>
      </div>
    </main>
  );
}
