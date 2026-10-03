/**
 * Production environment validation.
 *
 * Fails fast at server startup when required production configuration is missing
 * or unsafe, so a misconfigured deployment never silently serves traffic with
 * insecure defaults. Development and test stay permissive (the check is a no-op
 * unless NODE_ENV === "production"), so local workflows are unaffected.
 *
 * Only configuration that is ACTUALLY required by the current app is validated —
 * no speculative/future variables (e.g. no PostgreSQL vars; the app runs on
 * SQLite). Error messages name the offending variable and the reason ONLY; a
 * secret's value is NEVER included in an error, log, or stack trace.
 */

/** Public, well-known development placeholder for AUTH_SECRET (safe to reference). */
export const DEV_AUTH_SECRET_PLACEHOLDER = "dev-only-insecure-secret-change-me-please-32chars-min";

/** Minimum length for a production AUTH_SECRET. */
const MIN_AUTH_SECRET_LENGTH = 32;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/**
 * Validate the environment for production. No-op outside production.
 * Throws EnvValidationError listing every problem (variable names + reasons only).
 */
export function validateProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return; // dev/test are intentionally permissive

  const problems: string[] = [];

  // --- Database (required) ---
  if (!env.DATABASE_URL || env.DATABASE_URL.trim() === "") {
    problems.push("DATABASE_URL is required in production");
  }

  // --- Auth secret (must be present, not the dev placeholder, long enough) ---
  const secret = env.AUTH_SECRET;
  if (!secret || secret.trim() === "") {
    problems.push("AUTH_SECRET is required in production");
  } else if (secret === DEV_AUTH_SECRET_PLACEHOLDER) {
    problems.push("AUTH_SECRET must not use the development placeholder value in production");
  } else if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    problems.push(`AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters in production`);
  }

  // --- Rate limiting must stay enabled in production ---
  if (env.RATE_LIMIT_DISABLED === "true") {
    problems.push("RATE_LIMIT_DISABLED must not be 'true' in production");
  }

  // --- Session lifetime, if overridden, must be a positive integer ---
  if (env.SESSION_TTL_SECONDS !== undefined && env.SESSION_TTL_SECONDS !== "") {
    const ttl = Number(env.SESSION_TTL_SECONDS);
    if (!Number.isInteger(ttl) || ttl <= 0) {
      problems.push("SESSION_TTL_SECONDS must be a positive integer");
    }
  }

  // --- Background exports (optional; defaults: background runner, 168 h retention) ---
  if (env.EXPORT_RUNNER !== undefined && env.EXPORT_RUNNER !== "" && !["background", "inline"].includes(env.EXPORT_RUNNER.toLowerCase())) {
    problems.push('EXPORT_RUNNER must be "background" or "inline"');
  }
  if (env.EXPORT_RETENTION_HOURS !== undefined && env.EXPORT_RETENTION_HOURS !== "") {
    const h = Number(env.EXPORT_RETENTION_HOURS);
    if (!Number.isInteger(h) || h <= 0) problems.push("EXPORT_RETENTION_HOURS must be a positive integer");
  }

  if (problems.length > 0) {
    // Names + reasons only — never a secret's value.
    throw new EnvValidationError(`Invalid production environment configuration:\n- ${problems.join("\n- ")}`);
  }
}
