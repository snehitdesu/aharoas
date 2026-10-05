/**
 * Post-commit integration hooks (printing, messages, drawer kick) run after a
 * request has returned. Let them finish after every test, before a file's
 * afterAll disconnects Prisma — so no work spills into the next test file.
 */
import { afterEach } from "vitest";
import { settleAfterCommit } from "@/server/services/afterCommit";

afterEach(async () => {
  await settleAfterCommit();
});
