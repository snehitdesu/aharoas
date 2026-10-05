"use client";

import { Button } from "@/components/ui/Button";

/** Browser print (or "Save as PDF") of the current bill page. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button variant="primary" onClick={() => window.print()} data-autofocus>
      {label}
    </Button>
  );
}
