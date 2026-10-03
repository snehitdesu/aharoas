/**
 * POS cart state (pure reducer). The cart is only a DRAFT of what will be sent
 * to POST /api/orders; prices shown from it are estimates — the server prices
 * every line from the menu and its totals are what the UI shows after placing.
 */
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";
/** The OrderChannel values a counter POS creates (QR/ONLINE/AGGREGATOR arrive via their own channels). */
export const POS_ORDER_TYPES: Array<{ value: OrderType; label: string }> = [
  { value: "DINE_IN", label: "Dine-in" },
  { value: "TAKEAWAY", label: "Takeaway" },
  { value: "DELIVERY", label: "Delivery" },
];

export type CartLine = {
  key: string;
  menuItemId: string;
  name: string;
  variantId?: string;
  variantName?: string;
  modifierOptionIds: string[];
  modifierLabels: string[];
  /** Estimated unit price (item + variant), per the outlet menu. */
  unitPrice: number;
  /** Estimated modifier deltas per unit. */
  modifiersPerUnit: number;
  taxPct: number;
  qty: number;
  notes?: string;
};

export type CartCustomer = { id: string; name: string; phone: string | null };

export type CartState = {
  lines: CartLine[];
  orderType: OrderType;
  tableId: string | null;
  customer: CartCustomer | null;
  covers: number;
  notes: string;
  selectedKey: string | null;
};

export const emptyCart = (orderType: OrderType = "DINE_IN"): CartState => ({ lines: [], orderType, tableId: null, customer: null, covers: 1, notes: "", selectedKey: null });

export type CartAction =
  | { type: "add"; line: Omit<CartLine, "key"> }
  | { type: "inc" | "dec" | "remove" | "select"; key: string }
  | { type: "setQty"; key: string; qty: number }
  | { type: "setLineNote"; key: string; notes: string }
  | { type: "setOrderType"; orderType: OrderType }
  | { type: "setTable"; tableId: string | null }
  | { type: "setCustomer"; customer: CartCustomer | null }
  | { type: "setCovers"; covers: number }
  | { type: "setNotes"; notes: string }
  | { type: "clear" }
  /** Restore type/table/customer/covers from a saved order (clears draft lines). */
  | { type: "restoreContext"; orderType: OrderType; tableId: string | null; covers: number; customer: CartCustomer | null };

/** Lines with the same item, variant, modifiers and note are the same line (quantities merge). */
export function lineKey(l: Pick<CartLine, "menuItemId" | "variantId" | "modifierOptionIds" | "notes">): string {
  return [l.menuItemId, l.variantId ?? "", [...l.modifierOptionIds].sort().join(","), (l.notes ?? "").trim()].join("|");
}

const MAX_QTY = 999;

function withLines(state: CartState, lines: CartLine[]): CartState {
  const selectedKey = lines.some((l) => l.key === state.selectedKey) ? state.selectedKey : lines.at(-1)?.key ?? null;
  return { ...state, lines, selectedKey };
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "add": {
      const key = lineKey(action.line);
      const existing = state.lines.find((l) => l.key === key);
      const lines = existing
        ? state.lines.map((l) => (l.key === key ? { ...l, qty: Math.min(MAX_QTY, l.qty + action.line.qty) } : l))
        : [...state.lines, { ...action.line, key, qty: Math.min(MAX_QTY, Math.max(1, action.line.qty)) }];
      return { ...withLines(state, lines), selectedKey: key };
    }
    case "inc":
      return withLines(state, state.lines.map((l) => (l.key === action.key ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l)));
    case "dec":
      return withLines(state, state.lines.flatMap((l) => (l.key !== action.key ? [l] : l.qty > 1 ? [{ ...l, qty: l.qty - 1 }] : [])));
    case "setQty": {
      const qty = Math.floor(action.qty);
      if (!Number.isFinite(qty)) return state;
      return withLines(state, state.lines.flatMap((l) => (l.key !== action.key ? [l] : qty <= 0 ? [] : [{ ...l, qty: Math.min(MAX_QTY, qty) }])));
    }
    case "remove":
      return withLines(state, state.lines.filter((l) => l.key !== action.key));
    case "select":
      return { ...state, selectedKey: action.key };
    case "setLineNote": {
      // A note changes the line identity; merge into an identical line if one exists.
      const line = state.lines.find((l) => l.key === action.key);
      if (!line) return state;
      const notes = action.notes.slice(0, 200) || undefined;
      const updated = { ...line, notes, key: lineKey({ ...line, notes }) };
      const rest = state.lines.filter((l) => l.key !== action.key);
      const twin = rest.find((l) => l.key === updated.key);
      const lines = twin ? rest.map((l) => (l.key === updated.key ? { ...l, qty: Math.min(MAX_QTY, l.qty + updated.qty) } : l)) : [...rest, updated];
      return { ...withLines(state, lines), selectedKey: updated.key };
    }
    case "setOrderType":
      return { ...state, orderType: action.orderType, tableId: action.orderType === "DINE_IN" ? state.tableId : null };
    case "setTable":
      return { ...state, tableId: action.tableId };
    case "setCustomer":
      return { ...state, customer: action.customer };
    case "setCovers":
      return { ...state, covers: Math.max(1, Math.min(99, Math.floor(action.covers) || 1)) };
    case "setNotes":
      return { ...state, notes: action.notes.slice(0, 500) };
    case "clear":
      return emptyCart(state.orderType);
    case "restoreContext":
      return {
        ...emptyCart(action.orderType),
        tableId: action.orderType === "DINE_IN" ? action.tableId : null,
        covers: Math.max(1, Math.min(99, Math.floor(action.covers) || 1)),
        customer: action.customer,
      };
  }
}

const POS_CHANNELS: OrderType[] = ["DINE_IN", "TAKEAWAY", "DELIVERY"];

/** Cart context (not lines) from a persisted order so reopen shows the same customer/table/type. */
export function cartContextFromOrder(order: {
  channel: string;
  tableId: string | null;
  covers?: number | null;
  customer?: CartCustomer | null;
}): { orderType: OrderType; tableId: string | null; covers: number; customer: CartCustomer | null } {
  const orderType = POS_CHANNELS.includes(order.channel as OrderType) ? (order.channel as OrderType) : "TAKEAWAY";
  return {
    orderType,
    tableId: orderType === "DINE_IN" ? order.tableId : null,
    covers: order.covers && order.covers > 0 ? order.covers : 1,
    customer: order.customer ?? null,
  };
}

export const cartItemCount = (s: CartState) => s.lines.reduce((n, l) => n + l.qty, 0);

/** Why the cart cannot be placed yet (null = ready). */
export function cartBlocker(s: CartState): string | null {
  if (s.lines.length === 0) return "Add at least one item";
  if (s.orderType === "DINE_IN" && !s.tableId) return "Choose a table for dine-in";
  if (s.orderType === "DELIVERY" && !s.customer) return "Attach a customer for delivery";
  return null;
}

/** Items payload for POST /api/orders (server re-prices everything from the menu). */
export function toOrderItems(s: CartState) {
  return s.lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, modifierOptionIds: l.modifierOptionIds.length ? l.modifierOptionIds : undefined, qty: l.qty, notes: l.notes }));
}

/** Stable fingerprint of what would be sent; a changed cart needs a new idempotency key. */
export function cartFingerprint(s: CartState, extra = ""): string {
  return JSON.stringify([s.orderType, s.tableId, s.customer?.id ?? null, s.covers, s.notes, toOrderItems(s), extra]);
}
