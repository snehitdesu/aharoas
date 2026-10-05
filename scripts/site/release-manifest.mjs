/**
 * Writes src/site/release-manifest.json from the real desktop build output, so
 * the website shows the version, file names, sizes and SHA-256 checksums of the
 * artifacts that actually exist. Run after `npm run desktop:dist` (Windows) and,
 * when a Mac build has been produced and verified, with its DMGs copied into
 * dist-desktop/.
 *
 *   node scripts/site/release-manifest.mjs [distDir]
 *
 * The production website does not serve the files (only `next dev` streams
 * them from dist-desktop/ for local testing): upload them to the
 * release host (GitHub Releases, a CDN, object storage) and set
 * RESTORA_DOWNLOAD_BASE_URL to the folder URL (see docs/website.md).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist-desktop"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

function describe(file) {
  const full = path.join(dist, file);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(full));
  return { file, bytes: stat.size, sha256: hash.digest("hex"), builtAt: stat.mtime.toISOString().slice(0, 10) };
}

// File names follow electron-builder.yml artifactName patterns.
const manifest = {
  version,
  generatedAt: new Date().toISOString().slice(0, 10),
  windows: {
    installer: describe(`RESTORA-Setup-${version}.exe`),
    portable: describe(`RESTORA-Portable-${version}.exe`),
  },
  mac: {
    arm64: describe(`RESTORA-${version}-mac-arm64.dmg`),
    x64: describe(`RESTORA-${version}-mac-x64.dmg`),
  },
};

const out = path.join(root, "src", "site", "release-manifest.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${path.relative(root, out)}`);
for (const [os, files] of Object.entries({ windows: manifest.windows, mac: manifest.mac })) {
  for (const [k, v] of Object.entries(files)) console.log(`  ${os}.${k}: ${v ? `${v.file} (${(v.bytes / 1048576).toFixed(1)} MB)` : "not built"}`);
}
