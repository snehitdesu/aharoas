/**
 * One-time first-owner bootstrap for a fresh (migrated, EMPTY) database.
 *
 *   npm run bootstrap:owner                       (prompts for the password)
 *   echo "<password>" | npm run bootstrap:owner -- --password-stdin
 *
 * Configuration (environment):
 *   BOOTSTRAP_ORG_NAME, BOOTSTRAP_OUTLET_NAME, BOOTSTRAP_OUTLET_CODE,
 *   BOOTSTRAP_OWNER_NAME, BOOTSTRAP_OWNER_EMAIL           (required)
 *   BOOTSTRAP_TIMEZONE (default Asia/Kolkata), BOOTSTRAP_CURRENCY (default INR)
 *   BOOTSTRAP_OWNER_PASSWORD  (optional fallback for non-interactive runs;
 *                              prefer --password-stdin so it is not left in the env)
 *   DATABASE_URL              (as for the app; Prisma also reads .env)
 *
 * Refuses to run if any organization or user exists. Never prints the password.
 * Exit codes: 0 created, 1 bad/missing configuration or input, 2 already initialized, 3 unexpected error.
 */
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { bootstrapOwner, ALREADY_INITIALIZED } from "@/server/services/bootstrap";
import { PASSWORD_MIN_LENGTH } from "@/constants/password";

const REQUIRED = ["BOOTSTRAP_ORG_NAME", "BOOTSTRAP_OUTLET_NAME", "BOOTSTRAP_OUTLET_CODE", "BOOTSTRAP_OWNER_NAME", "BOOTSTRAP_OWNER_EMAIL"] as const;

function fail(code: number, message: string): never {
  process.stderr.write(`bootstrap: ${message}\n`);
  process.exit(code);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/** Read a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          return reject(new Error("Cancelled"));
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.argv.includes("--password-stdin")) return readStdin();
  if (process.stdin.isTTY) {
    process.stdout.write(`Owner password (min ${PASSWORD_MIN_LENGTH} characters, letters plus a number or symbol).\n`);
    const first = await promptHidden("Password: ");
    const second = await promptHidden("Repeat password: ");
    if (first !== second) fail(1, "passwords do not match");
    return first;
  }
  const fromEnv = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (fromEnv) return fromEnv;
  return fail(1, "no password: pipe it with --password-stdin, run interactively, or set BOOTSTRAP_OWNER_PASSWORD");
}

async function main() {
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length) fail(1, `missing required configuration: ${missing.join(", ")}`);
  const ownerPassword = await readPassword();

  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const result = await bootstrapOwner(prisma, {
      organizationName: process.env.BOOTSTRAP_ORG_NAME!,
      outletName: process.env.BOOTSTRAP_OUTLET_NAME!,
      outletCode: process.env.BOOTSTRAP_OUTLET_CODE!,
      timezone: process.env.BOOTSTRAP_TIMEZONE || undefined,
      currency: process.env.BOOTSTRAP_CURRENCY || undefined,
      ownerName: process.env.BOOTSTRAP_OWNER_NAME!,
      ownerEmail: process.env.BOOTSTRAP_OWNER_EMAIL!,
      ownerPassword,
    });
    process.stdout.write(
      `bootstrap: created organization ${result.organizationId}, outlet ${result.outletId} and owner ${result.ownerEmail} (${result.ownerId}).\n` +
        "bootstrap: sign in at /login with the owner email and the password you entered.\n"
    );
  } catch (e) {
    if (e instanceof ZodError) fail(1, `invalid configuration: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    const err = e as { name?: string; message?: string; details?: { fieldErrors?: { password?: string[] } } };
    if (err.message === ALREADY_INITIALIZED) fail(2, ALREADY_INITIALIZED);
    if (err.name === "ValidationError") fail(1, `password rejected: ${(err.details?.fieldErrors?.password ?? [err.message]).join("; ")}`);
    if (err.name?.startsWith("PrismaClient")) fail(3, `database error: ${err.message?.split("\n").filter(Boolean).slice(-1)[0] ?? "unknown"}`);
    fail(3, `unexpected error: ${err.message ?? String(e)}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
