import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// Recreate a clean test database and apply the schema before the suite runs.
//  - default: prisma/test.db (SQLite), deleted and re-pushed.
//  - TEST_DATABASE_URL=postgresql://...: the generated PostgreSQL schema
//    (prisma/postgres/schema.prisma) is force-reset into that database.
export default function setup() {
  // Resolve the Prisma CLI entry point and run it with the current Node binary
  // so we don't depend on `prisma` being on PATH inside a spawned shell.
  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve("prisma/build/index.js");

  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl?.startsWith("postgres")) {
    execFileSync(process.execPath, [prismaCli, "db", "push", "--schema", "prisma/postgres/schema.prisma", "--force-reset", "--skip-generate", "--accept-data-loss"], {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: pgUrl },
    });
    return;
  }

  const testDbPath = path.join(process.cwd(), "prisma", "test.db");
  const testDbUrl = `file:${testDbPath.replace(/\\/g, "/")}`;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = testDbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testDbUrl },
  });
}
