import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// Recreate a clean test database and apply the schema before the suite runs.
//  - default: prisma/test.db (SQLite), deleted and rebuilt with `migrate deploy`.
//  - TEST_DATABASE_URL=postgresql://...: the committed PostgreSQL migration
//    history (prisma/postgres/migrations) is applied with `migrate deploy` —
//    the production path. Nothing is reset: the database must be a FRESH,
//    disposable one (a CI service container, or `createdb` per run).
export default function setup() {
  // Resolve the Prisma CLI entry point and run it with the current Node binary
  // so we don't depend on `prisma` being on PATH inside a spawned shell.
  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve("prisma/build/index.js");

  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl?.startsWith("postgres")) {
    execFileSync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", "prisma/postgres/schema.prisma"], {
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
  // The committed SQLite migration history (the desktop/dev path), never `db push`:
  // every run proves the migrations reproduce the schema the services use.
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testDbUrl },
  });
}
