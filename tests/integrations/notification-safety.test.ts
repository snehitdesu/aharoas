/**
 * Phase 5B — notification provider production safety.
 *
 * The mock notification provider reports every send as delivered, so it must
 * NEVER be selected silently in production. getNotificationProvider must fail
 * loudly for an unavailable/mock provider in production, while staying easy in
 * development and tests.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { getNotificationProvider, MockNotificationProvider, EmailNotificationProvider } from "@/integrations/notification";
import { ProviderUnavailableError } from "@/integrations/policy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("notification provider safety", () => {
  it("production + real provider configured: returns the real provider", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_PROVIDER", "email");
    expect(getNotificationProvider()).toBeInstanceOf(EmailNotificationProvider);
  });

  it("production + provider missing (defaults to mock): fails loudly, never the mock", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getNotificationProvider()).toThrow(ProviderUnavailableError);
  });

  it("production + explicit opt-in (ALLOW_MOCK_PROVIDERS=true): mock allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_MOCK_PROVIDERS", "true");
    expect(getNotificationProvider()).toBeInstanceOf(MockNotificationProvider);
  });

  it("development + provider missing: mock provider (no friction)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(getNotificationProvider()).toBeInstanceOf(MockNotificationProvider);
  });

  it("test environment: mock provider", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(getNotificationProvider()).toBeInstanceOf(MockNotificationProvider);
  });

  it("unknown provider name: fails loudly (no silent mock fallback)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_PROVIDER", "pigeon-post");
    expect(() => getNotificationProvider()).toThrow(ProviderUnavailableError);
  });

  it("mock never silently activates in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_PROVIDER", "mock");
    expect(() => getNotificationProvider()).toThrow(/mock notification provider is disabled in production/i);
  });
});
