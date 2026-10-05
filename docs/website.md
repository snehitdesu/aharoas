# RESTORA public website

The public product website lives in the same Next.js app as RESTORA, in the
`src/app/(site)` route group. It shares the brand tokens (`tailwind.config.ts`)
but has its own scoped design system (`src/app/(site)/site.css`, everything under
`.site`), so no operator screen is affected.

## Pages
| Route | Source |
|---|---|
| `/` | `src/app/(site)/page.tsx`. The desktop build redirects `/` to `/dashboard` (`AHAROS_STANDALONE` / `AHAROS_DESKTOP`), so the packaged app still opens the operator app. |
| `/product`, `/product/<module>` | `product/page.tsx`, `product/[slug]/page.tsx`, content in `src/site/content.ts` |
| `/solutions` | `solutions/page.tsx` |
| `/download`, `/download/<target>` | `download/page.tsx`, redirect route `download/[target]/route.ts` |
| `/resources`, `/resources/release-notes`, `/security` | long-form pages |
| `/privacy`, `/terms` | **DRAFT FOR REVIEW**: legal entity, pricing, retention and liability are placeholders |
| `/sitemap.xml`, `/robots.txt` | `src/app/sitemap.ts`, `src/app/robots.ts` (robots keeps crawlers out of `/api`, sign-in, guest links and every operator route) |

Content rule: `src/site/content.ts` lists only shipped capabilities, with limits
stated (GST-ready not certified; Razorpay / Twilio contract-tested only;
aggregators mock; macOS unverified). `tests/site/website.test.ts` enforces: no
mock/planned integration shown as live, all referenced screenshots exist, no
"Aharos" and no em / en dashes in site sources, no secrets.

## Configuration
| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for metadata, Open Graph and the sitemap (no production domain chosen yet; defaults to `http://localhost:3000`). Build-time. |
| `RESTORA_DOWNLOAD_BASE_URL` | Folder URL where release files are hosted, e.g. `https://github.com/<owner>/<repo>/releases/download/v1.0.0-rc.1`. HTTPS only (plain HTTP allowed for localhost), no credentials. Unset = the site says the download is not published, except under `next dev` (see below). Read per request by `/download` and `/download/<target>`; the homepage section uses the value at build time. |

## Publishing a release
1. Build the installers (`npm run desktop:dist`, and on a Mac `npm run desktop:dist:mac` once verified; copy DMGs into `dist-desktop/`).
2. `node scripts/site/release-manifest.mjs` writes `src/site/release-manifest.json` (version, file names, sizes, SHA-256) from the real files.
3. Upload the files to the release host, set `RESTORA_DOWNLOAD_BASE_URL`, rebuild and deploy.
4. Check `/download`: the buttons become links, `/download/windows` redirects to the file and the checksum matches.

**Local development.** Under `npm run dev` (`NODE_ENV=development`) with `RESTORA_DOWNLOAD_BASE_URL` unset, `/download/<target>` streams the built file from `dist-desktop/` (the file name in the release manifest) as an attachment, and the button is enabled when that file exists; a missing file returns 404. `next build` / `next start` never read `dist-desktop/`: production still needs the release host.

## Product screenshots
All product imagery is the real application with sample data. To regenerate:
```bash
cp prisma/dev.db /tmp/site-demo.db
DATABASE_URL=file:/tmp/site-demo.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/site-demo.db ALLOW_DEMO_SEED=true npx tsx prisma/seed.ts
DATABASE_URL=file:/tmp/site-demo.db ALLOW_DEMO_SEED=true npx tsx scripts/site/demo-state.ts
npx next build
DATABASE_URL=file:/tmp/site-demo.db NODE_ENV=production ALLOW_MOCK_PROVIDERS=true AUTH_SECRET=<any 32+ chars> npx next start -p 3100
node scripts/site/capture-screens.mjs http://localhost:3100   # → public/site/screens/*.webp + src/site/screens-meta.json
node scripts/site/og-image.mjs http://localhost:3100          # → public/site/og.png
```
Never run the seed or `demo-state.ts` against real data (both refuse when non-demo users exist).

## QA
- `npx vitest run tests/site`
- `node scripts/site/check-site.mjs http://localhost:3100 [--shots=dir] [--reduced]`: every page at 390 to 1920 px wide; fails on horizontal overflow, broken images, console errors, more or less than one `<h1>`, text under 12 px, and internal links that 404.

## Identity
The website mark is `RestoraMark` / `RestoraLogo` in `src/site/components/Logo.tsx`: a geometric R closed by a terracotta full stop, the same stop the headlines end with. It is drawn from a rectangle, one arc stroke, a parallelogram and a circle on a 32 px grid, so it holds at 16 px and can be rasterized without a font. Tones: `espresso` (light grounds), `ivory` (dark grounds), `mono` (single colour). The favicon is `public/site/restora-mark.svg`.

The application (`src/components/layout/BrandMark.tsx`), the desktop icon (`desktop/scripts/make-icon.mjs`) and the captured product screenshots still carry the previous sunrise mark; moving them to the new mark is a separate, approved step.

## Art direction
`src/app/(site)/site-art.css` layers the art direction on the `site.css` tokens:

- Homepage rhythm: hero with a layered product stage, a scroll-lit statement, the chain card stack (signature), a full-bleed front-of-house band, an editorial QR split, the kitchen ticket rail, the back-of-house chapter (inventory, procurement slips, finance), a dark analytics band, roles, demo, solutions, principles with integrations, and a dark download finale.
- Grounds alternate ivory, sand and espresso; consecutive sections never share a layout.

## Motion
No animation library. Four kinds of motion, one curve (`--s-ease-out`):

- Arrival: CSS keyframes in the hero (`.s-arrive`, `.s-line`) and IntersectionObserver reveals elsewhere (`RevealController`, `.s-reveal`, staggered by `--i`).
- Progression: `src/site/motion.ts` (`useScrollFrame`) runs at most once per frame while an element is near the viewport and only writes CSS variables; `ScrollProgress` exposes `--p` for the hero stage parallax, the statement, the front-of-house scale and the kitchen rail. Scrolling stays native; nothing is pinned or snapped by script.
- Focus: `ChainStack` (desktop at least 1024 × 640) is plain CSS `position: sticky` cards with growing top offsets; the script writes `--e` (arrival) and `--d` (cards on top) for a small scale and a dimming veil. Below that size it is a normal sequence.
- Transition: tab cross-fades and ground changes.

Rules: only `transform`, `translate`, `scale` and `opacity` animate; moving layers get `will-change` only while motion is active; the sticky nav has no `backdrop-filter` (re-blurring moving layers every frame halved the frame rate). Content is visible without JavaScript, and `prefers-reduced-motion` removes arrivals, reveals and every scroll-linked transform while keeping the layout.
