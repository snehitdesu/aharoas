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

## Motion
No animation library. Section reveals (IntersectionObserver, `RevealController`), one sticky scroll story (`FlowStory`, CSS `position: sticky`), and tab cross-fades. Content is visible without JavaScript, and `prefers-reduced-motion` removes all transitions.
