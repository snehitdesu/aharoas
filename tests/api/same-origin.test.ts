import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOrigin } from "@/server/api/router";
import { insecureOriginProblem } from "@/server/auth/cookies";

const req = (headers: Record<string, string>) => new NextRequest("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers });
const saved = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("assertSameOrigin (CSRF defence-in-depth)", () => {
  it("allows requests without Origin and same-host browser requests", () => {
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).not.toThrow();
  });

  it("rejects a cross-site Origin and a malformed Origin", () => {
    expect(() => assertSameOrigin(req({ host: "pos.example.com", origin: "https://evil.example" }))).toThrow(/Cross-origin/);
    expect(() => assertSameOrigin(req({ host: "pos.example.com", origin: "not a url" }))).toThrow(/Invalid Origin/);
  });

  it("accepts the public host forwarded by the proxy chain (X-Forwarded-Host lists every hop)", () => {
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", "x-forwarded-host": "pos.example.com", origin: "https://pos.example.com" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", "x-forwarded-host": "pos.example.com, lb.internal:3000", origin: "https://pos.example.com" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", "x-forwarded-host": "pos.example.com, lb.internal:3000", origin: "https://evil.example" }))).toThrow(/Cross-origin/);
  });

  it("accepts the configured public origin when the proxy rewrites Host and sends no X-Forwarded-Host", () => {
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "https://pos.example.com" }))).toThrow(/Cross-origin/);
    process.env.PUBLIC_BASE_URL = "https://pos.example.com";
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "https://pos.example.com" }))).not.toThrow();
    // Only that exact origin: same host over another scheme is a different origin.
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "http://pos.example.com" }))).toThrow(/Cross-origin/);
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "https://evil.example" }))).toThrow(/Cross-origin/);
    delete process.env.PUBLIC_BASE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://restora.example";
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "https://restora.example" }))).not.toThrow();
  });
});

describe("insecureOriginProblem (Secure session cookie over plain HTTP)", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  it("refuses production sign-in from a plain-http, non-loopback page", () => {
    expect(insecureOriginProblem("http://192.168.1.20:3000", prod)).toMatch(/HTTPS/);
    expect(insecureOriginProblem("http://pos.example.com", prod)).toMatch(/HTTPS/);
  });
  it("allows https, loopback, non-browser clients and non-production", () => {
    expect(insecureOriginProblem("https://pos.example.com", prod)).toBeNull();
    expect(insecureOriginProblem("http://localhost:3000", prod)).toBeNull();
    expect(insecureOriginProblem("http://127.0.0.1:3000", prod)).toBeNull();
    expect(insecureOriginProblem(null, prod)).toBeNull();
    expect(insecureOriginProblem("http://192.168.1.20:3000", { NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
