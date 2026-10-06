# Coders' Cafe dataset (real menu)

RESTORA's demo / acceptance data uses a real restaurant's menu: **Coders' Cafe**,
transcribed from six photographs of its menu boards supplied by the owner
(2026-10-05, 23:28): the counter menu card and the three hanging boards above
the kitchen. Data: `prisma/coders-cafe/menu.ts` (every item names its source
photo). Seed: `prisma/coders-cafe/seed.ts`.

```
npm run db:seed:cafe              # add the cafe next to whatever the database holds (no-op if present)
npm run db:seed:cafe -- --reset   # delete ONLY the Coders' Cafe organization and rebuild it
```

Refused under `NODE_ENV=production` (public demo password, derivable QR tokens)
unless `ALLOW_DEMO_SEED=true` on a disposable database. Other organizations are
never touched (`tests/domain/coders-cafe-seed.test.ts`).

## What is imported

8 categories, 64 items (all on the KITCHEN station), 1 modifier group:

| Category | Items | Sizes |
|---|---|---|
| Appetizers | 9 | R / M / L as variants (base = R) where the board prices sizes |
| Chicken Delites | 9 | Popcorn Chicken R / M / L |
| Tossed Wings | 12 (4 flavours × 6 / 9 / 12 pc, ₹210 / 299 / 399) | separate items per pack size |
| Nachos | 3 | — |
| All Things Pasta | 11 | — |
| Thin Crust Pizzas | 13 | Regular / Medium; add-ons Extra Veggies +₹40, Make It a Cheese Melt +₹60 (max 2) |
| Salads | 3 | — |
| Coders' Fried Combos | 4 | — |

- Names as printed, including the boards' spellings ("Sause", "Arrabita", "Panco", "Chiken").
- Veg / non-veg: the board's mark where printed; otherwise from the item name (chicken, meatball). Items with neither were not imported.
- Descriptions: only text printed on the boards (one combo).
- Tax: not printed on the boards; RESTORA's default 5 % GST applies (owner-editable per item).
- Images: the boards have no per-item photographs usable at menu quality, and RESTORA's menu has no image field, so none are attached and no stock images are substituted.

## Not imported (unreadable, not guessed)

| Board entry | Why |
|---|---|
| Pink Sause Penne Chicken, Meatball Spaghetti (New) | the chicken-pasta column prints seven prices for six rows; 205 vs 215 cannot be assigned |
| Indian Barbecue Pizza (129 / 225) | veg status neither marked nor implied by the name |
| Chicken/Veg Topping (pizza add-on) | 55 or 65 |
| Greek Delite Salad | 160 or 180 |
| Chicken Tikka Salad | 185 or 186 |
| Burgers & Wraps board | names too blurred |
| 12 Pcs Mega Fried (599) | piece count cut off |
| Loaded Chee-sy Fries card + its upgrades | text too small; No Mercy's veg status not stated |
| Combo descriptions (All Chicken Box, Boneless Hot Crispy Meal for 2) | left edge cut off (names and prices imported) |

A clearer photo of those boards is enough to add them (edit `menu.ts`, re-run with `--reset`).

## Restaurant setup

| | |
|---|---|
| Organization / outlet | Coders' Cafe / Coders' Cafe (`CC01`), Asia/Kolkata, INR, invoice series `CC` |
| Tables | T01–T10, Main Floor, 4 seats (layout not on the boards: demo configuration), QR token per table derived from a fixed seed (stable across resets) |
| Users (password `Demo@12345`) | cafe.owner@demo.local (OWNER), cafe.manager@demo.local (MANAGER), cafe.chef@demo.local (KITCHEN), cafe.cashier@demo.local (CASHIER) |

The seed prints each table's guest link (`<PUBLIC_BASE_URL>/t/<token>`); the Tables
screen shows the scannable QR and downloads it as SVG. Before real use: rotate
every QR (Tables → QR → Rotate) and replace the demo users.

## Acceptance transaction

`e2e/investor/investor.spec.ts` (Table T07): Classic Margherita Pizza (Medium,
₹160) + Make It a Cheese Melt (₹60) + 2 × Classic Fries (Large, ₹110) = ₹440 +
5 % GST = **₹462.00** online; Loaded Veg Nachos (₹150) + Veg Arrabita Penne (₹185)
= **₹351.75** cash; Butter Garlic Wings (6 Pc) (₹210) = **₹220.50**, declined then paid.
