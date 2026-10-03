"use client";

/**
 * Form primitives. Validation is the server's job (Zod in the services); the
 * UI adds only input-level hints (required, numeric ranges) and maps the
 * server's 422 field errors back onto the fields. Empty optional inputs are
 * sent as `undefined`, never "", so optional schema fields stay unset.
 */
import { Children, cloneElement, createContext, forwardRef, isValidElement, useCallback, useContext, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ApiError, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

const control =
  "h-9 w-full rounded-md border border-ink-300 bg-white px-2.5 text-sm text-ink-900 placeholder:text-ink-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:bg-ink-100 disabled:text-ink-500 aria-[invalid=true]:border-bad-500";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = "", ...rest }, ref) {
  return <input ref={ref} className={`${control} ${className}`} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className = "", children, ...rest }, ref) {
  return (
    <select ref={ref} className={`${control} ${className}`} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className = "", ...rest }, ref) {
  return <textarea ref={ref} className={`${control} h-auto min-h-16 py-1.5 ${className}`} {...rest} />;
});

export function Checkbox({ label, checked, onChange, disabled, name }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; name?: string }) {
  const autoId = useId();
  const id = name ?? autoId;
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 text-sm text-ink-700">
      <input id={id} type="checkbox" name={name ?? id} className="h-4 w-4 rounded border-ink-300" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ---------------- server error mapping ----------------

type FieldErrors = Record<string, string>;
const ErrorsCtx = createContext<FieldErrors>({});

/** Field errors from a 422 (Zod `flatten()` details); nested keys collapse to their top-level field. */
export function fieldErrors(e: unknown): FieldErrors {
  if (!(e instanceof ApiError)) return {};
  const d = e.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined;
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(d?.fieldErrors ?? {})) if (v?.length) out[k] = v[0];
  return out;
}

/** Form-level messages (refinements) from a 422, or the error's message. */
export function formError(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { formErrors?: string[] } | undefined;
    if (d?.formErrors?.length) return d.formErrors.join(" ");
    if (e.kind === "validation" && Object.keys(fieldErrors(e)).length) return "Please fix the highlighted fields.";
  }
  return describeError(e);
}

export function Field({ label, name, hint, required, children, className = "" }: { label: ReactNode; name?: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  const errors = useContext(ErrorsCtx);
  const generated = useId();
  const fallbackId = name ?? generated;
  const err = name ? errors[name] : undefined;
  const describedBy = err ? `${fallbackId}-error` : undefined;
  const only = Children.toArray(children).filter(isValidElement);
  const child = only.length === 1 ? only[0] : null;
  const bindNative = Boolean(child && (child.type === Input || child.type === Select || child.type === Textarea));
  let controlId = fallbackId;
  const control = bindNative && child
    ? (() => {
        const existing = child.props as { id?: string; name?: string; "aria-invalid"?: boolean; "aria-describedby"?: string; "aria-required"?: boolean };
        controlId = existing.id ?? fallbackId;
        return cloneElement(child, {
          id: controlId,
          name: existing.name ?? name ?? controlId,
          "aria-invalid": err ? true : existing["aria-invalid"],
          "aria-describedby": describedBy ?? existing["aria-describedby"],
          "aria-required": required ? true : existing["aria-required"],
        } as never);
      })()
    : children;
  return (
    <label htmlFor={bindNative ? controlId : undefined} className={`flex flex-col gap-1 text-sm ${className}`}>
      <span className="font-medium text-ink-700">
        {label}
        {required && <span aria-hidden className="text-bad-500"> *</span>}
      </span>
      {control}
      {err ? <span id={describedBy} role="alert" className="text-xs text-bad-500">{err}</span> : hint ? <span className="text-xs text-ink-500">{hint}</span> : null}
    </label>
  );
}

/** Server error for one field, for composite inputs that aren't a single <Field>. */
export function FieldError({ name }: { name: string }) {
  const err = useContext(ErrorsCtx)[name];
  return err ? <span role="alert" className="text-xs text-bad-500">{err}</span> : null;
}

/** Provide field errors to nested <Field name> without a dialog. */
export function FormErrors({ errors, children }: { errors: FieldErrors; children: ReactNode }) {
  return <ErrorsCtx.Provider value={errors}>{children}</ErrorsCtx.Provider>;
}

export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="mb-3 rounded-md border border-bad-100 bg-bad-50 px-3 py-2 text-sm text-bad-700">{message}</p>;
}

/**
 * Run a submit, capturing field/form errors. Returns [submit, state].
 * One submission at a time (double-submit safe).
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const reset = useCallback(() => {
    setErrors({});
    setMessage(null);
  }, []);
  const submit = useCallback(
    async <R,>(fn: () => Promise<R>): Promise<{ ok: true; value: R } | { ok: false }> => {
      if (busy) return { ok: false };
      setBusy(true);
      reset();
      try {
        return { ok: true, value: await fn() };
      } catch (e) {
        setErrors(fieldErrors(e));
        setMessage(formError(e));
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [busy, reset]
  );
  return { submit, busy, errors, message, reset, setMessage };
}

/**
 * Modal form. `onSubmit` performs the API call; on success the dialog closes
 * and `onDone` runs. Server validation errors stay in the dialog.
 */
export function FormDialog<R>({
  open,
  onClose,
  title,
  description,
  submitLabel = "Save",
  onSubmit,
  onDone,
  children,
  size,
  danger = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel?: string;
  onSubmit: () => Promise<R>;
  onDone?: (result: R) => void;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  danger?: boolean;
}) {
  const s = useSubmit();
  const formId = `form-${title.replace(/\W+/g, "-").toLowerCase()}`;
  const close = () => {
    s.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button onClick={close} disabled={s.busy}>Cancel</Button>
          <Button type="submit" form={formId} variant={danger ? "danger" : "primary"} loading={s.busy}>{submitLabel}</Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate={false}
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await s.submit(onSubmit);
          if (r.ok) {
            s.reset();
            onClose();
            onDone?.(r.value);
          }
        }}
        className="flex flex-col gap-3"
      >
        <FormAlert message={s.message} />
        <ErrorsCtx.Provider value={s.errors}>{children}</ErrorsCtx.Provider>
      </form>
    </Dialog>
  );
}

// ---------------- value helpers ----------------

/** "" -> undefined (optional string fields). */
export const opt = (v: string): string | undefined => (v.trim() === "" ? undefined : v.trim());
/** "" -> undefined, otherwise Number (the server rejects NaN). */
export const optNum = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
