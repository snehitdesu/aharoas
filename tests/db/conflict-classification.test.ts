/**
 * Serialization conflicts are recognised however Prisma reports them: P2034
 * from its own queries, or P2010 + SQLSTATE 40001 / 40P01 from a raw query (the
 * KOT nextval() inside an order transaction). Both are retried by runInTx and
 * become 503 + Retry-After when retries run out — never a 500.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { isSerializationConflict } from "@/server/db/conflict";
import { runInTx } from "@/server/services/_workflow";
import { fail } from "@/server/api/respond";

const known = (code: string, message: string) => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client });
const raw40001 = () => known("P2010", 'Raw query failed. Code: `40001`. Message: `ERROR: could not serialize access due to read/write dependencies among transactions`');

describe("serialization conflict classification", () => {
  it("P2034 and raw-query P2010 with 40001 / 40P01 are conflicts; other P2010s, P2002 and unknown errors are not", () => {
    expect(isSerializationConflict(known("P2034", "Transaction failed due to a write conflict or a deadlock"))).toBe(true);
    expect(isSerializationConflict(raw40001())).toBe(true);
    expect(isSerializationConflict(known("P2010", "Raw query failed. Code: `40P01`. Message: `deadlock detected`"))).toBe(true);
    expect(isSerializationConflict(known("P2010", "Raw query failed. Code: `42P01`. Message: `relation does not exist`"))).toBe(false);
    expect(isSerializationConflict(known("P2002", "Unique constraint failed"))).toBe(false);
    expect(isSerializationConflict(new Error("could not serialize access"))).toBe(false);
    expect(isSerializationConflict(null)).toBe(false);
  });

  it("a raw-query conflict is retried by runInTx and, if it persists, answers 503 + Retry-After (not 500)", async () => {
    let calls = 0;
    const fakeDb = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { calls++; if (calls < 3) throw raw40001(); return fn({}); } };
    await expect(runInTx(fakeDb as never, async () => "done")).resolves.toBe("done");
    expect(calls).toBe(3);
    const res = fail(raw40001());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
  });
});

describe("database outage classification (Phase 12 restart drill)", () => {
  it("unreachable / restarting database answers 503 + Retry-After; ordinary errors stay 500", async () => {
    const { isDatabaseUnavailable } = await import("@/server/db/conflict");
    const unreachable = known("P1001", "Can't reach database server at `127.0.0.1:55433`");
    const shutting = new Prisma.PrismaClientUnknownRequestError("Error in connector: Error querying the database: FATAL: the database system is shutting down", { clientVersion: Prisma.prismaVersion.client });
    const terminated = new Prisma.PrismaClientUnknownRequestError("FATAL: terminating connection due to administrator command", { clientVersion: Prisma.prismaVersion.client });
    for (const e of [unreachable, shutting, terminated]) {
      expect(isDatabaseUnavailable(e)).toBe(true);
      const res = fail(e);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      expect(JSON.stringify(await res.json())).not.toMatch(/55433|connector|FATAL/);
    }
    expect(isDatabaseUnavailable(known("P2002", "Unique constraint failed"))).toBe(false);
    expect(isDatabaseUnavailable(new Error("the database system is shutting down"))).toBe(false); // not a Prisma error
    expect(fail(known("P2025", "Record not found")).status).toBe(500);
  });
});
