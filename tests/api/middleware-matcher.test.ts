import { describe, expect, it } from "vitest";
import { config, PROTECTED_PAGES } from "@/middleware";

describe("middleware matcher", () => {
  it("runs on every protected page (a missing entry loses the post-login return path)", () => {
    for (const page of PROTECTED_PAGES) expect(config.matcher, page).toContain(`${page}/:path*`);
  });
});
