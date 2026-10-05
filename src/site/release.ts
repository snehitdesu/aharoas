/**
 * Desktop release information for the public website.
 *
 * - What exists comes from release-manifest.json, generated from the real build
 *   output by `node scripts/site/release-manifest.mjs` (version, file, size,
 *   SHA-256). Nothing here is typed in by hand.
 * - Where it is hosted comes from RESTORA_DOWNLOAD_BASE_URL (server-side env,
 *   e.g. https://github.com/<owner>/<repo>/releases/download/v1.0.0). Until it
 *   is set, the site says the download is not published instead of linking to
 *   a file that does not exist.
 *
 * Visitors download through /download/<platform>, a redirect route, so the host
 * can change without touching any page.
 */
import manifest from "./release-manifest.json";

export type Artifact = { file: string; bytes: number; sha256: string; builtAt: string };
type Manifest = {
  version: string;
  generatedAt: string;
  windows: { installer: Artifact | null; portable: Artifact | null };
  mac: { arm64: Artifact | null; x64: Artifact | null };
};

const m = manifest as Manifest;

export const release = { version: m.version, generatedAt: m.generatedAt };

/** Download targets, keyed by the /download/<key> route. */
export const TARGETS = {
  windows: { label: "Windows installer", artifact: m.windows.installer },
  "windows-portable": { label: "Windows portable", artifact: m.windows.portable },
  "mac-arm64": { label: "macOS (Apple Silicon)", artifact: m.mac.arm64 },
  "mac-x64": { label: "macOS (Intel)", artifact: m.mac.x64 },
} as const;
export type TargetKey = keyof typeof TARGETS;

export function downloadBase(): string | null {
  const base = process.env.RESTORA_DOWNLOAD_BASE_URL?.trim();
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return null;
    if (u.username || u.password) return null; // never publish credentials in a link
    return base.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The artifact URL for a target, or null when it is not built or not published. */
export function artifactUrl(key: TargetKey): string | null {
  const base = downloadBase();
  const a = TARGETS[key].artifact;
  return base && a ? `${base}/${encodeURIComponent(a.file)}` : null;
}

export type TargetStatus = { key: TargetKey; label: string; artifact: Artifact | null; available: boolean; href: string };

export function targetStatus(key: TargetKey): TargetStatus {
  const t = TARGETS[key];
  const available = artifactUrl(key) !== null;
  return { key, label: t.label, artifact: t.artifact, available, href: `/download/${key}` };
}

export const formatSize = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/** Everything the download UI needs, resolved on the server. */
export function downloadState() {
  return {
    version: release.version,
    windows: targetStatus("windows"),
    portable: targetStatus("windows-portable"),
    macArm: targetStatus("mac-arm64"),
    macIntel: targetStatus("mac-x64"),
  };
}
