/**
 * Password policy — shared by the server (authoritative) and the forms (hints).
 * Client-safe: no Node APIs.
 *
 * bcrypt only uses the first 72 BYTES of its input, so longer passwords would be
 * silently truncated; the policy rejects them instead.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword",
  "1234567890", "12345678910", "0123456789", "9876543210", "1111111111", "0000000000",
  "qwertyuiop", "qwerty1234", "qwerty12345", "asdfghjkl", "letmein123", "welcome123", "admin12345", "iloveyou12",
  "changeme123", "aharos1234", "aharos12345", "restora123", "restora1234", "restora12345", "restaurant",
]);

/** Every policy violation for `password` (empty = acceptable). */
export function passwordProblems(password: string, ctx: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) problems.push(`Use at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} plain characters)`);
  if (password.trim() !== password) problems.push("Do not start or end with a space");
  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) problems.push("Include at least one letter and one number or symbol");
  if (/^(.)\1+$/.test(password)) problems.push("Do not repeat a single character");
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push("This password is too common");
  const email = ctx.email?.toLowerCase().trim();
  const local = email?.split("@")[0];
  if (email && (lower === email || (local && local.length >= 4 && lower.includes(local)))) problems.push("Do not use your email address");
  const name = ctx.name?.toLowerCase().replace(/\s+/g, "");
  if (name && name.length >= 4 && lower.replace(/\s+/g, "").includes(name)) problems.push("Do not use your name");
  return problems;
}
