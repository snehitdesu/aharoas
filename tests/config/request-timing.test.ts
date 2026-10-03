import { describe, it, expect } from "vitest";
import { applyTimingHeaders, newRequestId } from "@/server/observability/timing";

describe("request timing", () => {
  it("accepts a well-formed incoming request id and rejects junk", () => {
    expect(newRequestId("req_abc-DEF.123")).toBe("req_abc-DEF.123");
    expect(newRequestId("no")).not.toBe("no"); // too short
    expect(newRequestId("email=secret@x.com")).not.toContain("@");
    expect(newRequestId(null)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("sets x-request-id and Server-Timing without a body", () => {
    const headers = new Headers();
    applyTimingHeaders(headers, "rid-1", 12.34);
    expect(headers.get("x-request-id")).toBe("rid-1");
    expect(headers.get("Server-Timing")).toBe("app;dur=12.3");
  });
});
