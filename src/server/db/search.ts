/**
 * Case-insensitive "contains" for user search boxes.
 *
 * SQLite's LIKE ignores ASCII case, but PostgreSQL's does not: on PostgreSQL a
 * search for "paneer" found no "Paneer" (verified against PostgreSQL 16). Prisma
 * offers `mode: "insensitive"` on PostgreSQL only (it is an unknown argument on
 * SQLite), so the filter is chosen from the configured database at runtime.
 */
function isPostgres(): boolean {
  return (process.env.DATABASE_URL ?? "").startsWith("postgres");
}

const INSENSITIVE = { mode: "insensitive" };

/** `{ contains }` that matches regardless of letter case on every supported database. */
export function textContains(value: string): { contains: string } {
  return isPostgres() ? { contains: value, ...INSENSITIVE } : { contains: value };
}
