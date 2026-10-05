# Phase 11 — RESTORA UI/UX transformation

_2026-10-05. Visual and brand transformation only: no API, business-logic,
financial or inventory behaviour was changed for it._

## Status: **PASS WITH DOCUMENTED LIMITATIONS**

## 1. Direction
**RESTORA — "The Operating System for Restaurants."** Retro-modern editorial:
a warm ivory / beige paper foundation with a faint printed grain, espresso-brown
ink, terracotta as the single action colour, saffron highlights, and earthy
semantic colours. Headlines are set in a bold editorial serif; everything
operational (buttons, tables, forms, tickets) stays in a highly legible sans so
speed is never traded for decoration. Retro accents are used sparingly: a
"printed" offset shadow on emphasis surfaces (primary KPI, dialogs, sign-in
card), ruled table headers, small-caps eyebrow labels, and a sun-and-stripes
brand mark.

## 2. Design system
All of it is token-driven; screens kept their class names, so the whole app
re-themed from one place (the codebase had **zero** raw Tailwind palette
colours — every colour went through tokens).

| Layer | Where | What |
|---|---|---|
| Colour tokens | `tailwind.config.ts` | `brand` terracotta, `vanilla`/`accent` saffron, `ink` espresso ramp (50 = page … 900 = headline), `paper` surfaces, `espresso` chrome, `ok` sage, `warn` ochre, `bad` brick, `info` teal |
| Semantic CSS variables, grain, headings, eyebrow, selection, scrollbars, skeleton, reduced motion, print | `src/app/globals.css` | paper grain = static inline SVG noise (allowed by CSP `img-src data:`), no runtime cost |
| Typography | `src/app/layout.tsx` | Fraunces (display: `h1`, `h2`, `.font-display`, KPI figures) + Inter (UI), both self-hosted at build time by `next/font` (CSP `font-src 'self'`; works offline in the desktop app) |
| Radius / shadows | tokens | tighter radii (6–12 px), warm low shadows, `shadow-print` (3 px offset espresso) |
| Primitives | `src/components/ui/*` | Button (terracotta primary with a pressed base line; paper secondary; danger/success/accent), Badge, Card, Stat, MetricCard (display-serif figures, accent rail, printed emphasis), DataTable (ruled header and footer, saffron row hover), Dialog (espresso frame, terracotta top rule, printed shadow, display title), Toast (espresso cards), Empty / Error / Forbidden states, Spinner, Skeleton, form controls (paper fields, terracotta focus, accent checkboxes) |
| Shells | `src/components/layout/*` | espresso side navigation with terracotta active rail; paper top bar; operator bar for POS / KDS / captain / manager (espresso + terracotta rule, compact on phones); editorial sign-in (espresso poster panel + paper card); new `BrandMark`, `Wordmark`, tagline |
| Desktop | `desktop/static/*`, `desktop/main/*`, `desktop/scripts/make-icon.mjs` | splash + setup wizard re-themed, window colours, menu / dialog text, **new application icon** rasterised from the new mark |

### Contrast (WCAG 2.1, checked by script for every pair the primitives use)
Body text 15.3:1, secondary 9.6:1, muted text ≥ 5.0:1 on page and paper,
white on terracotta buttons 5.4:1, links 7.2:1, every badge tone ≥ 5.3:1,
ivory on espresso navigation 16.7:1 (muted 10.1:1), terracotta active icon on
espresso 4.2:1, `ink-400` (icons / placeholders / disabled only) ≥ 3.4:1. The
previous palette's `ink-400` was ~2.5:1 and was used for three small text labels;
those labels now use `ink-500`.

## 3. Brand rename (user-visible only)
"Aharos" → **RESTORA** in every page title (~70), the app/root metadata, the
sign-in and password pages, error and not-found pages, the printer test page,
the desktop window titles, splash, setup wizard, menus, dialogs, installer
product name, shortcut and artifact names (`RESTORA-Setup-<version>.exe`).

Deliberately **unchanged** (upgrade safety): `appId com.aharos.desktop`, the
executable name, the `%APPDATA%\Aharos` data directory (the app pins Electron's
`userData` to it explicitly), `AHAROS_*` environment variables, `aharos.db`,
cookie names, the npm package name. Existing installations therefore upgrade in
place and keep their data and settings; sign-in sessions are unaffected.

## 4. Screens reviewed in the real production build
Captured with headless Chromium against a freshly seeded database at desktop
(1440×900) and phone (Pixel 7) sizes and reviewed: sign-in (desktop + phone),
dashboard, POS, kitchen display, stock, finance, analytics, menu, orders,
captain app (phone), manager app (phone). Defects found and fixed during the
review:
1. Operator bar overflowed on phones (wordmark, title, outlet and "Sign out"
   wrapped onto two lines) → wordmark and divider hidden below `sm`, outlet name
   truncates, sign-out becomes icon-only with an accessible label.
2. Sidebar tagline truncated → wraps.
3. Dashboard used a private KPI tile and header style → aligned with the design
   system (display figures, eyebrow labels, printed primary KPI).
4. Phone sign-in card floated mid-screen under a large gap → top-aligned below
   the masthead.

Operational guarantees kept: POS tiles, KDS tickets and their action buttons
keep their size and touch targets (XL buttons 56 px), the KDS stays
high-contrast (espresso / paper / terracotta), status colours stay distinct
(sage / ochre / brick / teal), keyboard focus rings are terracotta and visible on
every interactive element, `prefers-reduced-motion` is honoured.

## 5. Tests changed (brand text only)
`e2e/login.spec.ts` (heading "Sign in" + the RESTORA brand panel instead of an
"Aharos" heading) and `desktop/e2e/desktop.spec.ts` ("RESTORA is ready",
"Open RESTORA", window title). No assertion about behaviour was changed.

## 6. Validation
Run after the last UI change (2026-10-05):

| Gate | Result |
|---|---|
| Typecheck / lint | ✅ 0 errors / no warnings |
| UI component tests (`tests/ui`) | ✅ 228/228 |
| Full suite, SQLite | ✅ 884 passed (80 files) |
| Production web build | ✅ (fonts self-hosted at build time) |
| Browser E2E (production build) | ✅ 77/77 — incl. `SEC-HDR-002` zero CSP violations on the main screens with the new fonts and grain |
| Desktop build + E2E | ✅ 7/7 — incl. the setup wizard ("RESTORA is ready"), and CSP in the Electron renderer (scripts, styles, **fonts**, API) |
| Packaged desktop (`desktop:verify`) | ✅ 23/23 — incl. upgrade of a previous-release installation in place: data, owner sign-in and session intact under the new product name |

## 7. Known limitations
- Screens are re-themed through the shared design system and the shells; they
  were not individually re-laid-out. The manager / captain phone KPI tiles and
  some feature-local components keep their (re-themed) layouts.
- The guest QR ordering pages (`/t/<token>`) and the bill / receipt pages
  inherit the theme but were not screenshot-reviewed in this phase (covered by
  the QR and bill E2E journeys).
- No dark mode.
- The installer is still unsigned (Phase 10, external certificate).
