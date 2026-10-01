/**
 * Provider policy shared by the integration factories.
 *
 * Mock adapters approve anything (a mock "gateway" verifies every payment and
 * invents refund ids), so they must never run in production by accident. The
 * webhook entry point already refused them; the payment / POS factories used by
 * verification, refunds and reconciliation did not — and silently fell back to
 * the mock for unknown provider names. Both now fail loudly.
 */
export class ProviderUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

/** Mocks run anywhere except production, where ALLOW_MOCK_PROVIDERS=true must opt in explicitly. */
export function mockProvidersAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_MOCK_PROVIDERS === "true";
}

export function assertMockAllowed(kind: string): void {
  if (!mockProvidersAllowed()) throw new ProviderUnavailableError(`The mock ${kind} provider is disabled in production (configure a real provider, or set ALLOW_MOCK_PROVIDERS=true for a non-public test deployment)`);
}

export function unknownProvider(kind: string, name: string): never {
  throw new ProviderUnavailableError(`Unknown ${kind} provider "${name}"`);
}
