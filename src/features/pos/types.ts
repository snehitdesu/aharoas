/** Shapes returned by the existing /api endpoints the POS consumes (Decimals arrive as strings). */
export type Money = string | number;

export type ModifierOptionDTO = { id: string; name: string; priceDelta: Money; active: boolean };
export type ModifierGroupDTO = { id: string; name: string; minSelect: number; maxSelect: number; active: boolean; options: ModifierOptionDTO[] };
export type VariantDTO = { id: string; name: string; priceDelta: Money; active: boolean };

/** GET /api/menu?outletId=…&activeOnly=true (per-outlet effective values). */
export type MenuItemDTO = {
  id: string;
  name: string;
  description: string | null;
  price: Money;
  taxPct: Money;
  station: string;
  isVeg: boolean;
  active: boolean;
  soldOut: boolean;
  categoryId: string | null;
  category: { id: string; name: string; sortOrder: number } | null;
  variants: VariantDTO[];
  modifierGroups: Array<{ group: ModifierGroupDTO }>;
  effectivePrice: number;
  offered: boolean;
  effectiveSoldOut: boolean;
};

/** GET /api/master/tables?outletId=… */
export type TableDTO = { id: string; code: string; capacity: number; status: string; floorId: string | null; floor: { name: string } | null };

export type CustomerDTO = { id: string; name: string; phone: string | null; email: string | null };

export type OrderItemDTO = { id: string; name: string; qty: Money; unitPrice: Money; lineTotal: Money; notes: string | null; menuItemId: string | null; modifiers: Array<{ name: string; priceDelta: Money }> };
export type PaymentDTO = { id: string; method: string; status: string; amount: Money; refunds?: Array<{ amount: Money }> };

/** GET /api/orders/:id — `customer` is the display relation; `customerId` is the FK. */
export type OrderDTO = {
  id: string;
  outletId: string;
  channel: string;
  status: string;
  tableId: string | null;
  customerId: string | null;
  customer?: CustomerDTO | null;
  covers: number;
  notes: string | null;
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
  createdAt: string;
  items: OrderItemDTO[];
  payments?: PaymentDTO[];
  kots?: Array<{ id: string; number: number; status: string }>;
};
