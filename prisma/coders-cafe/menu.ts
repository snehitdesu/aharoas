/**
 * Coders' Cafe — the real restaurant menu used for RESTORA's demo / acceptance
 * dataset, transcribed from the six menu-board photographs the owner supplied
 * (WhatsApp images, 2026-10-05 23:28, Downloads/"WhatsApp Unknown 2026-10-05 at
 * 11.28.58 PM"): the counter menu card (11.28.03 PM, 11.28.05 PM) and the
 * hanging boards above the kitchen (11.28.05 PM (1)/(2), 11.28.06 PM).
 *
 * Rules followed (see docs/coders-cafe-menu.md for the full provenance table):
 *  - Names are printed as on the boards (including the boards' own spellings:
 *    "Sause", "Arrabita", "Panco", "Agli Olio", "Chiken").
 *  - Prices are the boards' prices in rupees. Sizes are the boards' sizes:
 *    R / M / L → base price = R, variants "Medium" / "Large" carry the difference;
 *    pizzas: Regular / Medium; wings: separate 6 / 9 / 12 pc items (the board
 *    prices them as columns, and the POS "Regular" base label would mislabel 6 pc).
 *  - isVeg: "board" = a veg / non-veg mark printed next to the item or its
 *    column; "name" = the item name names the meat (chicken, meatball) or is a
 *    plain vegetable / cheese dish. Items whose veg status could not be read
 *    either way were left out.
 *  - Nothing was guessed: an item whose name or price could not be read with
 *    certainty in at least one photo is listed in UNRESOLVED and NOT imported.
 *  - No descriptions are invented: only text printed on the board is used.
 *  - Taxes are not printed on the boards. Items use RESTORA's default GST rate
 *    for restaurant service (5 %, MenuItem.taxPct default); the owner can change
 *    it per item in Menu → Items.
 *  - The boards carry no per-item photographs that can be cropped at usable
 *    quality, and RESTORA's menu has no image field, so no images are attached
 *    (no stock images are substituted).
 */

export type VegBasis = "board" | "name";
export type CafeVariant = { name: string; price: number };
export type CafeItem = {
  name: string;
  /** Base (smallest-size) price in rupees. */
  price: number;
  /** Larger sizes with their full board price (the seed stores the difference as priceDelta). */
  sizes?: CafeVariant[];
  isVeg: boolean;
  vegBasis: VegBasis;
  description?: string;
  /** Photo(s) the item was read from. */
  source: string;
  /** Attach the "Pizza Add-ons" modifier group. */
  pizzaAddOns?: boolean;
};
export type CafeCategory = { name: string; sortOrder: number; items: CafeItem[] };

const COUNTER = "counter menu card (11.28.05 PM)";
const BOARDS = "hanging boards (11.28.05 PM (1)/(2), 11.28.06 PM)";
const BOTH = `${COUNTER}; ${BOARDS}`;

const RML = (m: number, l?: number): CafeVariant[] => [{ name: "Medium", price: m }, ...(l === undefined ? [] : [{ name: "Large", price: l }])];
const MEDIUM = (m: number): CafeVariant[] => [{ name: "Medium", price: m }];

function wings(name: string): CafeItem[] {
  return [
    { name: `${name} (6 Pc)`, price: 210, isVeg: false, vegBasis: "name", source: BOTH },
    { name: `${name} (9 Pc)`, price: 299, isVeg: false, vegBasis: "name", source: BOTH },
    { name: `${name} (12 Pc)`, price: 399, isVeg: false, vegBasis: "name", source: BOTH },
  ];
}

export const CODERS_CAFE_MENU: CafeCategory[] = [
  {
    name: "Appetizers",
    sortOrder: 10,
    items: [
      { name: "Crisp Cajun Onion Rings", price: 99, sizes: RML(120), isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Classic Fries", price: 85, sizes: RML(95, 110), isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Peri Peri/Lemon Garlic Fries", price: 95, sizes: RML(110, 120), isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Cheesy Juicy Fries", price: 115, sizes: RML(125, 140), isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Baked Potato Wedges", price: 110, isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Jalapeno Cheese Balls", price: 140, isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Cheese Stuffed Mushroom", price: 130, isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Chilli Cheese Nachos", price: 89, sizes: RML(110, 130), isVeg: true, vegBasis: "name", source: BOTH },
      { name: "Broccoli Cheese Kibbeh", price: 150, isVeg: true, vegBasis: "name", source: BOTH },
    ],
  },
  {
    name: "Chicken Delites",
    sortOrder: 20,
    items: [
      { name: "Guntur Chiken 65", price: 240, isVeg: false, vegBasis: "name", source: BOTH },
      { name: "Popcorn Chicken", price: 99, sizes: RML(149, 199), isVeg: false, vegBasis: "name", source: BOTH },
      { name: "Chicken Nuggets", price: 150, isVeg: false, vegBasis: "name", source: BOTH },
      { name: "Crunchy Chicken (3 Pc)", price: 190, isVeg: false, vegBasis: "name", source: BOTH },
      { name: "Chicken Cheese Balls", price: 159, isVeg: false, vegBasis: "name", source: BOTH },
      { name: "Chicken Strips (3 Pc)", price: 180, isVeg: false, vegBasis: "name", source: BOTH },
      { name: "Panco Fried Chicken", price: 180, isVeg: false, vegBasis: "name", source: BOTH },
      { name: "BBQ Grilled Chicken", price: 190, isVeg: false, vegBasis: "name", source: BOTH },
      { name: "Spicy Grilled Chicken", price: 190, isVeg: false, vegBasis: "name", source: BOTH },
    ],
  },
  {
    name: "Tossed Wings",
    sortOrder: 30,
    items: [...wings("Butter Garlic Wings"), ...wings("Creamy Chicken Wings"), ...wings("BBQ Chicken Wings"), ...wings("Spicy Chicken Wings")],
  },
  {
    name: "Nachos",
    sortOrder: 40,
    items: [
      { name: "Cheesy Nachos with Dip", price: 140, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Loaded Veg Nachos", price: 150, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Loaded Chicken Nachos", price: 160, isVeg: false, vegBasis: "board", source: BOTH },
    ],
  },
  {
    name: "All Things Pasta",
    sortOrder: 50,
    items: [
      // Left (veg-marked) column.
      { name: "Veg Creamy Alfredo Pasta", price: 185, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Veg Arrabita Penne", price: 185, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Veg Pink Sause Penne", price: 190, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Veg Creamy Spaghetti", price: 185, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Veg Arrabita Spaghetti", price: 185, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Veg Pink Sause Spaghetti", price: 190, isVeg: true, vegBasis: "board", source: BOTH },
      { name: "Agli Olio Spaghetti Pasta", price: 180, isVeg: true, vegBasis: "board", source: BOTH },
      // Right (non-veg-marked) column: the four rows whose price aligns unambiguously.
      { name: "Chicken Arrabita Penne Chicken", price: 205, isVeg: false, vegBasis: "board", source: BOTH },
      { name: "Creamy Alfredo Penne Chicken", price: 205, isVeg: false, vegBasis: "board", source: BOTH },
      { name: "Creamy Alfredo Spaghetti", price: 205, isVeg: false, vegBasis: "board", source: BOTH },
      { name: "Chicken Pink Sause Spaghetti", price: 205, isVeg: false, vegBasis: "board", source: BOTH },
    ],
  },
  {
    name: "Thin Crust Pizzas",
    sortOrder: 60,
    items: [
      { name: "Classic Margherita Pizza", price: 99, sizes: MEDIUM(160), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Simply Veg", price: 99, sizes: MEDIUM(175), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Farmpizza", price: 109, sizes: MEDIUM(185), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Corn Special", price: 129, sizes: MEDIUM(220), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Onion and Paneer", price: 129, sizes: MEDIUM(220), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Peri Peri Mushroom Pizza", price: 129, sizes: MEDIUM(220), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Spicy Paneer Pizza", price: 139, sizes: MEDIUM(235), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Tandoori Paneer Pizza", price: 129, sizes: MEDIUM(225), isVeg: true, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Simply Chicken", price: 150, sizes: MEDIUM(270), isVeg: false, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "BBQ Chicken Pizza", price: 150, sizes: MEDIUM(270), isVeg: false, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Chicken Tikka Pizza", price: 150, sizes: MEDIUM(270), isVeg: false, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Tandoori Chicken Pizza", price: 190, sizes: MEDIUM(310), isVeg: false, vegBasis: "name", source: BOTH, pizzaAddOns: true },
      { name: "Chicken Kheema Pizza", price: 160, sizes: MEDIUM(290), isVeg: false, vegBasis: "name", source: BOTH, pizzaAddOns: true },
    ],
  },
  {
    name: "Salads",
    sortOrder: 70,
    items: [
      { name: "Paneer Tikka Salad", price: 170, isVeg: true, vegBasis: "board", source: BOARDS },
      { name: "Pasta Veg Salad", price: 170, isVeg: true, vegBasis: "board", source: BOARDS },
      { name: "Pasta & Herb Chicken", price: 220, isVeg: false, vegBasis: "board", source: BOARDS },
    ],
  },
  {
    name: "Coders' Fried Combos",
    sortOrder: 80,
    items: [
      { name: "Epic Savings 9 Pcs Fried", price: 299, isVeg: false, vegBasis: "name", source: BOARDS },
      { name: "All Chicken Box", price: 499, isVeg: false, vegBasis: "name", source: BOARDS },
      { name: "Chicken Popcorn + Fries Bucket", price: 280, description: "Large Popcorn + Med Fries", isVeg: false, vegBasis: "name", source: BOARDS },
      { name: "Boneless Hot Crispy Meal for 2", price: 380, isVeg: false, vegBasis: "name", source: BOARDS },
    ],
  },
];

/** The pizza board's add-ons box (veg-marked). "Chicken/Veg Topping" is unresolved (55 or 65). */
export const PIZZA_ADD_ONS = { name: "Pizza Add-ons", minSelect: 0, maxSelect: 2, options: [{ name: "Extra Veggies", priceDelta: 40 }, { name: "Make It a Cheese Melt", priceDelta: 60 }] };

/** Read on the boards but NOT imported: name, price or veg status not readable with certainty. */
export const UNRESOLVED: Array<{ item: string; reason: string }> = [
  { item: "Pink Sause Penne Chicken", reason: "the chicken-pasta column prints seven prices for six rows (205/205/205/215/205/205/205); 205 vs 215 cannot be assigned" },
  { item: "Meatball Spaghetti (New)", reason: "same misaligned price column (205 vs 215)" },
  { item: "Indian Barbecue Pizza (129 / 225)", reason: "veg / non-veg is neither marked nor implied by the name" },
  { item: "Chicken/Veg Topping (pizza add-on)", reason: "price reads 55 or 65" },
  { item: "Greek Delite Salad", reason: "price reads 160 or 180" },
  { item: "Chicken Tikka Salad", reason: "price reads 185 or 186" },
  { item: "Burgers & Wraps board (7 items)", reason: "item names too blurred to transcribe" },
  { item: "12 Pcs Mega Fried combo (599)", reason: "piece count partly cut off" },
  { item: "Loaded Chee-sy Fries card (Double Trouble, Chilli Paneer Charm, Chicken BBQ, The Italian Job, No Mercy) and its Super Upgrade add-ons", reason: "names / prices too small to read with certainty, and veg status of No Mercy (220) is not stated" },
  { item: "Combo descriptions (All Chicken Box, Boneless Hot Crispy Meal for 2)", reason: "left edge of the text is cut off; names and prices imported without descriptions" },
];

export function menuItemCount(menu: CafeCategory[] = CODERS_CAFE_MENU): number {
  return menu.reduce((n, c) => n + c.items.length, 0);
}
