# Desktop release, update and recovery (H7)

Status as of 2026-10-04. What is **implemented and verified**, and what is
**required before** shipping signed builds or automatic updates.

## Release artifacts
`npm run desktop:dist` → `dist-desktop/Aharos-Setup-<version>.exe` (NSIS, per-user,
`%LOCALAPPDATA%\Programs\Aharos`) and `Aharos-Portable-<version>.exe`.
`npm run desktop:pack` → `dist-desktop/win-unpacked/` (same app, no installer).

**macOS (configured, NOT yet verified on a Mac — see below).**
`npm run desktop:dist:mac` (on a Mac) → `dist-desktop/RESTORA-<version>-mac-<arch>.dmg`;
`npm run desktop:pack` on a Mac → `dist-desktop/mac-arm64/RESTORA.app` (Apple
Silicon) or `dist-desktop/mac/RESTORA.app` (Intel). Data lives in
`~/Library/Application Support/Aharos`. The DMG is built for the arch of the Mac
that builds it, because the server payload's native modules (Prisma query engine,
sharp) are the build machine's; `desktop/scripts/after-pack.cjs` refuses a package
whose native modules do not match its target (so a Mac package cannot be produced
from Windows, and an Intel DMG cannot be produced on Apple Silicon). CI builds both:
`.github/workflows/ci.yml` job `desktop-macos` (arm64 + x64 runners) runs the
desktop E2E, `desktop:verify` and the DMG build and uploads each DMG.

Not yet done for macOS: **(1)** no run on real Mac hardware or a macOS CI runner
has happened yet — treat the macOS build as unverified until the `desktop-macos`
job (or the steps below on a Mac) passes; **(2)** no Developer ID signing or
notarization: the app is ad-hoc signed and Gatekeeper requires right-click → Open
on first launch. To sign and notarize: GitHub secrets `MAC_CSC_LINK` /
`MAC_CSC_KEY_PASSWORD` (Developer ID Application certificate, .p12) and
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` passed to the
`desktop-macos` job; verify with `codesign --verify --deep --strict` and
`spctl -a -vv dist-desktop/mac-arm64/RESTORA.app`.

Manual macOS check (on a Mac): `npm ci && npm run desktop:build && npm run desktop:e2e
&& npx electron-builder --mac --dir --publish never && npm run desktop:verify &&
npx electron-builder --mac --publish never`, then open the DMG, drag RESTORA to
Applications, launch it, complete setup, sign in, take an order through POS → KOT
→ KDS → payment, print a test page from Settings → Printers, back up, quit (⌘Q),
relaunch and confirm the data persisted.

- **Version** = `package.json` `version` (app, installer file name, backup manifests).
  Bump it for every release; the installer upgrades in place (same `appId`
  `com.aharos.desktop`).
- **Data** lives in `%APPDATA%\Aharos` (`data\aharos.db`, `backups\`, `logs\`,
  `config.json`) — never inside the install directory. Uninstall and upgrade keep it
  (`deleteAppDataOnUninstall: false`).
- **Never published by a build.** `publish: null` in `electron-builder.yml` and
  `--publish never` in the scripts: a CI run with a GitHub token cannot create a
  release by accident.

## Security of the packaged app (verified by `npm run desktop:verify`)
| Control | Where |
|---------|-------|
| Renderer: `sandbox`, `contextIsolation`, no `nodeIntegration`, `webSecurity`, DevTools off when packaged; `app.enableSandbox()` for every renderer | `desktop/main/main.ts` |
| Renderer may only load/request the local server origin (plus data:/blob:); navigation, redirects, popups and `<webview>` blocked; all permissions denied | `main.ts` `installSecurity`, `policy.ts` |
| App preload exposes 4 functions, setup preload 3; every IPC handler checks sender frame + origin and validates arguments | `desktop/preload/*`, `main.ts`, `policy.ts` |
| Child processes get an allow-listed environment (no developer `DATABASE_URL`, `NODE_OPTIONS`, provider secrets) | `policy.ts` `childEnv` |
| Per-install `AUTH_SECRET` encrypted with `safeStorage` (DPAPI on Windows, Keychain on macOS) | `desktop/main/config.ts` |
| macOS: hardened runtime with only the JIT + library-validation entitlements Electron and the native server modules need; no sandbox/network/device entitlements | `desktop/mac/entitlements.mac.plist` |
| **Electron fuses:** `RunAsNode`, `NODE_OPTIONS`, `--inspect` disabled; cookie encryption on; app loads only from `app.asar` with **embedded integrity validation**. `GrantFileProtocolExtraPrivileges` stays on: the splash / setup pages are `file://` pages in `app.asar` and fail to load without it (found by `desktop:verify`) | `electron-builder.yml` `electronFuses` |
| Packaged app exits if started with `--remote-debugging-port/-pipe/-address`, `--inspect*` or `--js-flags` | `main.ts` + `policy.ts` `hasDebugSwitch` |
| Build fails on `.env` / database files in the payload or any `.env` value found in it (secret scan) | `desktop/scripts/build.mjs` |

Playwright drives Electron through `--inspect`, which the fuses deliberately
block. The full desktop E2E (`npm run desktop:e2e`) therefore runs the same app
code on the unpacked build with the stock Electron binary; the **fused** binary is
checked by `npm run desktop:verify` (fuse wire, real start-up + upgrade + sign-in,
`ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `--inspect` / `--remote-debugging-port`
attacks, tampered `app.asar` refused).

## Upgrades and migrations (verified)
On every start the DB tool runs `desktop/runtime/upgrade.ts`:
1. **Refuse without touching anything** a database that has tables but no history,
   contains a migration this version does not know (written by a newer version —
   downgrade protection), has an edited applied migration (checksum), or an
   unfinished migration.
2. **Verified pre-migration backup** (`backups\aharos-<stamp>-pre-migration.db` +
   manifest with SHA-256) before anything is applied to existing data.
3. Forward migrations, **one transaction each**, `foreign_key_check` before commit.

Tests: `tests/desktop/upgrade-restore.test.ts` (a database from the previous release,
ad547ae, with real rows → upgrade → rows intact, history accepted by `prisma migrate
status`; failing migration → rolled back, data intact; newer database refused) and
`tests/desktop/migrator.test.ts`.

### If an upgrade fails
The app shows "Aharos could not start … No data was deleted" and does not start.
The database is at a migration boundary (the failed migration rolled back).
- Install the fixed version → it continues from that boundary; or
- go back to the previous version: replace `%APPDATA%\Aharos\data\aharos.db` with
  the newest `backups\*-pre-migration.db` (delete `aharos.db-wal` / `-shm` first)
  and reinstall the previous installer. The previous version refuses the
  partially-upgraded file (unknown migrations), never damages it.

## Backup and restore (verified)
- Backups are `VACUUM INTO` snapshots, verified (`integrity_check`, history, SHA-256
  manifest) **before** they are kept; automatic every 12 h (14 kept), manual,
  pre-migration and pre-restore backups are never rotated.
- They are in the user's own profile (`%APPDATA%\Aharos\backups`, user-only ACL by
  default). They contain the whole database (incl. password hashes): treat copies
  as confidential. Backup **encryption is not implemented**.
- **Restore** (menu, Owner + fresh password re-confirmation): verifies the chosen
  file, refuses backups from a newer version, stops the server, takes a verified
  pre-restore backup, verifies the exact copy swapped in, migrates it. **If the
  restored file cannot be migrated, the pre-restore data is put back
  automatically** (`desktop/runtime/restore.ts`, `RestoreRolledBackError`).
- Logs never contain passwords or the install secret; they contain e-mail
  addresses of setup/restore actors and blocked URLs (first 200 characters).

## Code signing — NOT configured (installers are unsigned)
No certificate exists in this repository or CI. Unsigned installers trigger
SmartScreen warnings and cannot be verified by an updater. Required:
1. An **OV or EV code-signing certificate** issued to the publisher (EV, or OV with
   reputation, avoids SmartScreen warnings). Since 2023 these are issued on a
   hardware token / cloud HSM: plan for **Azure Trusted Signing** or an HSM-backed
   signing service rather than a `.pfx` file.
2. For a `.pfx`: GitHub secrets `WIN_CSC_LINK` (base64 or https URL of the .pfx)
   and `WIN_CSC_KEY_PASSWORD`; `.github/workflows/ci.yml` already passes them to
   electron-builder as `CSC_LINK` / `CSC_KEY_PASSWORD`. For Azure Trusted Signing,
   add `win.azureSignOptions` in `electron-builder.yml` and the Azure credentials
   as secrets.
3. Verify: `Get-AuthenticodeSignature dist-desktop\Aharos-Setup-<v>.exe` →
   `Valid`, and the same for `win-unpacked\Aharos.exe` and the bundled `.node` files.
Never commit certificates, keys or passwords.

## Automatic updates — NOT implemented (by decision)
There is no updater in the app. Updates are manual: run the new installer (data
and backups are kept; the next start migrates with a verified backup). An updater
must not be enabled until **all** of these exist:
1. Signed installers (above); `electron-updater` verifies the publisher of the
   downloaded installer against the running app (`win.publisherName`).
2. A trusted update channel over HTTPS controlled by Aharos (GitHub Releases or a
   static host), publishing `latest.yml` with SHA-512 of each installer; publishing
   only from a protected release workflow, never from ordinary CI.
3. Update flow: download → verify signature + hash → **verified backup** → install
   → start-up migration (already safe, above). Never auto-install during service
   hours; let the Owner choose the time.
4. Rollback = reinstall the previous signed installer + restore the pre-migration
   backup (above). Staged rollout per outlet before all tills.
