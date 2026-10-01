"use client";

import { useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormAlert, Textarea, formError } from "@/components/ui/Form";
import { useToast } from "@/components/ui/Toast";

export type ConfirmSpec = {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Require a non-empty note (e.g. dismissing an anomaly); passed to the action. */
  requireNote?: boolean;
  /** Offer an optional note field. */
  note?: boolean;
  noteLabel?: string;
};

/**
 * Button that runs one server action (optionally behind a confirmation
 * dialog). The server decides whether the action is legal; failures are shown
 * in the dialog (or as a toast) and nothing is assumed on the client.
 */
export function ActionButton({
  action,
  confirm,
  success,
  onDone,
  children,
  ...button
}: Omit<ButtonProps, "onClick"> & {
  action: (note?: string) => Promise<unknown>;
  confirm?: ConfirmSpec;
  success?: string;
  onDone?: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const run = async () => {
    if (busy) return;
    if (confirm?.requireNote && !note.trim()) {
      setErr(`${confirm.noteLabel ?? "A note"} is required.`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await action(note.trim() || undefined);
      setOpen(false);
      setNote("");
      if (success) toast.show(success, "ok");
      onDone?.();
    } catch (e) {
      if (confirm) setErr(formError(e));
      else toast.show(formError(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button {...button} loading={busy && !confirm} onClick={() => (confirm ? setOpen(true) : run())}>
        {children}
      </Button>
      {confirm && (
        <Dialog
          open={open}
          onClose={() => !busy && (setOpen(false), setErr(null))}
          title={confirm.title}
          size="sm"
          footer={
            <>
              <Button onClick={() => (setOpen(false), setErr(null))} disabled={busy}>Cancel</Button>
              <Button variant={confirm.danger ? "danger" : "primary"} loading={busy} onClick={run} data-autofocus>
                {confirm.confirmLabel ?? "Confirm"}
              </Button>
            </>
          }
        >
          <FormAlert message={err} />
          <div className="text-sm text-ink-700">{confirm.message}</div>
          {(confirm.note || confirm.requireNote) && (
            <label className="mt-3 flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-700">
                {confirm.noteLabel ?? "Note"}
                {confirm.requireNote && <span aria-hidden className="text-bad-500"> *</span>}
              </span>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required={confirm.requireNote} />
            </label>
          )}
        </Dialog>
      )}
    </>
  );
}
