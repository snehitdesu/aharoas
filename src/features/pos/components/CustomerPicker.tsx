"use client";

import { useState } from "react";
import { api, describeError } from "@/lib/api/client";
import type { CustomerDTO } from "@/features/pos/types";
import type { CartCustomer } from "@/features/pos/cart";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";

/** Phone lookup against /api/customers; creation only for users with customer.manage. */
export function CustomerPicker({ current, canCreate, onSelect, onClose }: { current: CartCustomer | null; canCreate: boolean; onSelect: (c: CartCustomer | null) => void; onClose: () => void }) {
  const [phone, setPhone] = useState(current?.phone ?? "");
  const [name, setName] = useState("");
  const [results, setResults] = useState<CustomerDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cleaned = phone.replace(/[^\d+]/g, "");

  async function search() {
    if (cleaned.length < 6) return setError("Enter at least 6 digits");
    setBusy(true);
    setError(null);
    try {
      setResults(await api<CustomerDTO[]>("/api/customers", { query: { phone: cleaned } }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const c = await api<CustomerDTO>("/api/customers", { method: "POST", body: { name: name.trim(), phone: cleaned } });
      onSelect({ id: c.id, name: c.name, phone: c.phone });
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Customer" description="Find by phone number" size="sm">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="flex gap-2">
          <label className="flex-1">
            <span className="sr-only">Phone</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Phone number" data-autofocus className="h-10 w-full rounded-md border border-ink-300 px-3 text-sm" />
          </label>
          <Button type="submit" loading={busy && !name}>Find</Button>
        </div>
        {error && <p role="alert" className="text-sm text-bad-500">{error}</p>}
        {results && results.length > 0 && (
          <ul className="divide-y divide-ink-100 rounded-md border border-ink-300">
            {results.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onSelect({ id: c.id, name: c.name, phone: c.phone })} className="w-full px-3 py-2 text-left text-sm hover:bg-ink-100">
                  <span className="font-medium">{c.name}</span> <span className="text-ink-500">{c.phone}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {results && results.length === 0 && (
          canCreate ? (
            <div className="space-y-2 rounded-md border border-ink-300 p-3">
              <p className="text-sm text-ink-700">No customer with this number. Add them?</p>
              <label className="block text-sm">
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-ink-300 px-3 text-sm" />
              </label>
              <Button variant="primary" onClick={create} disabled={!name.trim()} loading={busy}>Add customer</Button>
            </div>
          ) : (
            <p className="text-sm text-ink-500">No customer with this number.</p>
          )
        )}
        {current && (
          <Button variant="ghost" onClick={() => onSelect(null)}>Remove {current.name} from order</Button>
        )}
      </form>
    </Dialog>
  );
}
