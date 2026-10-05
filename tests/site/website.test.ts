/**
 * Public website guards: download wiring never invents or leaks links, every
 * screenshot the content references exists, and the published copy keeps the
 * brand and style rules (RESTORA only, no em / en dashes).
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULES, INTEGRATIONS, SOLUTIONS } from "@/site/content";
import { SCREENS } from "@/site/screens";

const root = process.cwd();
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const siteSources = [...walk(path.join(root, "src", "site")), ...walk(path.join(root, "src", "app", "(site)"))].filter((f) => /\.(tsx?|css)$/.test(f));

describe("downloads", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  const load = () => import("@/site/release");

  it("offers nothing to download until a release host is configured", async () => {
    vi.stubEnv("RESTORA_DOWNLOAD_BASE_URL", "");
    const r = await load();
    expect(r.downloadBase()).toBeNull();
    expect(r.artifactUrl("windows")).toBeNull();
    expect(r.targetStatus("windows").available).toBe(false);
  });

  it("links built artifacts under the configured host, and never unbuilt ones", async () => {
    vi.stubEnv("RESTORA_DOWNLOAD_BASE_URL", "https://downloads.example.com/v1/");
    const r = await load();
    const win = r.TARGETS.windows.artifact;
    if (win) expect(r.artifactUrl("windows")).toBe(`https://downloads.example.com/v1/${encodeURIComponent(win.file)}`);
    for (const k of Object.keys(r.TARGETS) as (keyof typeof r.TARGETS)[]) {
      if (!r.TARGETS[k].artifact) expect(r.artifactUrl(k)).toBeNull();
    }
  });

  it("refuses insecure hosts and URLs carrying credentials", async () => {
    for (const bad of ["http://downloads.example.com", "https://user:secret@downloads.example.com", "ftp://x", "not a url"]) {
      vi.stubEnv("RESTORA_DOWNLOAD_BASE_URL", bad);
      vi.resetModules();
      expect((await load()).downloadBase(), bad).toBeNull();
    }
    vi.stubEnv("RESTORA_DOWNLOAD_BASE_URL", "http://localhost:8099");
    vi.resetModules();
    expect((await load()).downloadBase()).toBe("http://localhost:8099");
  });

  it("serves local builds only under next dev with no release host", async () => {
    vi.stubEnv("RESTORA_DOWNLOAD_BASE_URL", "");
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      vi.resetModules();
      const r = await load();
      for (const k of Object.keys(r.TARGETS) as (keyof typeof r.TARGETS)[]) expect(r.localArtifactPath(k), `${env} ${k}`).toBeNull();
    }
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    let r = await load();
    const win = r.TARGETS.windows.artifact;
    if (win) expect(r.localArtifactPath("windows")).toBe(path.join(root, "dist-desktop", win.file));
    for (const k of Object.keys(r.TARGETS) as (keyof typeof r.TARGETS)[]) {
      if (!r.TARGETS[k].artifact) expect(r.localArtifactPath(k)).toBeNull();
    }
    vi.stubEnv("RESTORA_DOWNLOAD_BASE_URL", "https://downloads.example.com/v1");
    vi.resetModules();
    r = await load();
    expect(r.localArtifactPath("windows")).toBeNull();
  });

  it("matches the release manifest to package.json", async () => {
    const r = await load();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(r.release.version).toBe(pkg.version);
    for (const t of Object.values(r.TARGETS)) if (t.artifact) expect(t.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("content", () => {
  it("uses only screenshots that exist", () => {
    for (const s of Object.values(SCREENS)) expect(fs.existsSync(path.join(root, "public", s.src)), s.src).toBe(true);
    for (const m of MODULES) for (const s of m.screens) expect(SCREENS[s], `${m.slug}: ${s}`).toBeTruthy();
  });

  it("links related modules that exist", () => {
    const slugs = new Set(MODULES.map((m) => m.slug));
    for (const m of MODULES) for (const r of m.related) expect(slugs.has(r), `${m.slug} -> ${r}`).toBe(true);
    for (const s of SOLUTIONS) for (const r of s.modules) expect(slugs.has(r)).toBe(true);
  });

  it("never labels a mock or planned integration as live", () => {
    for (const i of INTEGRATIONS) {
      if (i.status.includes("mock") || i.status.includes("planned")) expect(i.status).not.toContain("live");
    }
  });

  it("keeps public copy on brand: RESTORA only, no em or en dashes", () => {
    for (const f of siteSources) {
      const text = fs.readFileSync(f, "utf8");
      expect(/aharos/i.test(text.replace(/AHAROS_(STANDALONE|DESKTOP)/g, "")), `${f} mentions the internal working name`).toBe(false);
      expect(/[–—]/.test(text), `${f} contains an em or en dash`).toBe(false);
    }
  });

  it("keeps the public site free of server secrets", () => {
    for (const f of siteSources) {
      const text = fs.readFileSync(f, "utf8");
      expect(text).not.toMatch(/AUTH_SECRET|DATABASE_URL|INTEGRATION_SECRETS_KEY|rzp_live_|PAYMENT_WEBHOOK_SECRET/);
    }
  });
});
