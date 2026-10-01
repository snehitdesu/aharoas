/**
 * Body handling for the hand-written /api/auth/* routes (they sit outside
 * createRouter because most are reachable without a session): same-origin
 * check, small size cap, strict JSON.
 */
import type { NextRequest } from "next/server";
import { assertSameOrigin } from "@/server/api/router";
import { ValidationError } from "@/server/db/scope";

export async function readAuthJson(req: NextRequest, maxChars = 10_000): Promise<Record<string, unknown>> {
  assertSameOrigin(req);
  const text = await req.text();
  if (text.length > maxChars) throw new ValidationError("Payload too large");
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new ValidationError("Request body must be valid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Request body must be a JSON object");
  return body as Record<string, unknown>;
}
