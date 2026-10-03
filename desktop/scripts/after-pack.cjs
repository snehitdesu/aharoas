/**
 * electron-builder afterPack hook: copy the server payload (build/desktop/server,
 * already secret-scanned by build.mjs) verbatim into resources/server.
 *
 * Done here instead of `extraResources` because electron-builder 26 silently
 * drops every node_modules directory from extraResources, and the standalone
 * Next.js server needs its traced node_modules (incl. .prisma/client + engine).
 * Runs before the NSIS / portable targets are built, so both contain it.
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, "build", "desktop", "server");
  const dest = path.join(context.appOutDir, "resources", "server");
  if (!fs.existsSync(path.join(src, "server.js"))) throw new Error(`Server payload missing at ${src}; run desktop/scripts/build.mjs first`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  for (const required of ["server.js", "dbtool.js", "migrations", ".next/BUILD_ID", "node_modules/next", "node_modules/@prisma/client", "node_modules/.prisma/client/query_engine-windows.dll.node"]) {
    if (!fs.existsSync(path.join(dest, required))) throw new Error(`Packaged server is missing ${required}`);
  }
  console.log(`  • aharos server payload copied  dest=${path.relative(context.packager.projectDir, dest)}`);
};
