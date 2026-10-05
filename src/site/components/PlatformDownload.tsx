"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TargetStatus } from "@/site/release";

type Platform = "windows" | "mac" | "other";

const sizeOf = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/**
 * Download cards for Windows, macOS and the web app. After hydration the
 * visitor's platform is detected and its card is marked "for this device";
 * the other options are never hidden. Availability is decided on the server
 * (release manifest + RESTORA_DOWNLOAD_BASE_URL) and passed in.
 */
export function PlatformDownload({
  version,
  windows,
  portable,
  macArm,
  macIntel,
  webHref,
  compact = false,
}: {
  version: string;
  windows: TargetStatus;
  portable: TargetStatus;
  macArm: TargetStatus;
  macIntel: TargetStatus;
  webHref: string;
  compact?: boolean;
}) {
  const [platform, setPlatform] = useState<Platform>("other");
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = (nav.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
    const mobile = /android|iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
    setPlatform(mobile ? "other" : p.includes("win") ? "windows" : p.includes("mac") ? "mac" : "other");
  }, []);

  const macAvailable = macArm.available || macIntel.available;
  const cards = [
    {
      key: "windows" as const,
      name: "Windows",
      title: "RESTORA for Windows",
      lead: platform === "windows" ? "Your device is ready for RESTORA." : "The complete RESTORA on one Windows computer.",
      body: (
        <>
          <Facts
            rows={[
              ["Version", version],
              ["File", windows.artifact ? `Installer (.exe), ${sizeOf(windows.artifact.bytes)}` : "Not built"],
              ["Requires", "Windows 10 or 11, 64-bit"],
            ]}
          />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <DownloadButton status={windows} label="Download for Windows" primary />
            {!compact && portable.artifact && (
              <DownloadButton status={portable} label={`Portable .exe, ${sizeOf(portable.artifact.bytes)}`} />
            )}
          </div>
          {!windows.available && <Unpublished what={`The Windows installer for ${version} is built but is not yet hosted for public download.`} />}
        </>
      ),
    },
    {
      key: "mac" as const,
      name: "macOS",
      title: "RESTORA for macOS",
      lead: platform === "mac" ? (macAvailable ? "Built for your Mac." : "Coming to your Mac.") : "For Apple Silicon and Intel Macs.",
      body: (
        <>
          <Facts
            rows={[
              ["Version", macAvailable ? version : "Not released yet"],
              ["File", "Disk image (.dmg)"],
              ["Builds", "Apple Silicon and Intel, built separately"],
            ]}
          />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <DownloadButton status={macArm} label="Apple Silicon" primary />
            <DownloadButton status={macIntel} label="Intel" />
          </div>
          {!macAvailable && <Unpublished what="The macOS app is configured but has not yet been verified on a Mac, so it is not offered for download." />}
        </>
      ),
    },
    {
      key: "other" as const,
      name: "Web",
      title: "RESTORA Web",
      lead: "No installation required.",
      body: (
        <>
          <Facts
            rows={[
              ["Runs in", "A modern browser, tested in Chromium"],
              ["Hosting", "Your RESTORA web deployment"],
              ["Data", "PostgreSQL on the server"],
            ]}
          />
          <div className="mt-6">
            <Link href={webHref} className="s-btn s-btn-dark">
              Open RESTORA
            </Link>
          </div>
        </>
      ),
    },
  ];

  // The visitor's own platform first; nothing is hidden.
  const ordered = [...cards].sort((a, b) => Number(b.key === platform) - Number(a.key === platform));

  return (
    <ul className="grid gap-5 lg:grid-cols-3">
      {ordered.map((c) => {
        const mine = c.key === platform;
        return (
          <li
            key={c.key}
            className={`flex flex-col rounded-[var(--s-radius-lg)] p-7 sm:p-8 ${mine ? "bg-[color:var(--s-surface)] shadow-[0_0_0_2px_var(--s-accent),0_24px_48px_-32px_rgb(36_24_15/0.5)]" : "bg-[color:var(--s-surface)] shadow-[0_0_0_1px_rgb(36_24_15/0.1)]"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="s-eyebrow">{c.name}</p>
              {mine && <p className="text-sm font-semibold text-[color:var(--s-accent-ink)]">For this device</p>}
            </div>
            <h3 className="s-h3 mt-4">{c.title}</h3>
            <p className="mt-2 text-[1.0625rem] text-[color:var(--s-ink)]">{c.lead}</p>
            <div className="mt-6 flex flex-1 flex-col">{c.body}</div>
          </li>
        );
      })}
    </ul>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid gap-2 text-[0.9375rem]">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[6.5rem_1fr] gap-3 border-t border-[color:var(--s-rule)] pt-2">
          <dt className="text-[color:var(--s-muted)]">{k}</dt>
          <dd className="s-num text-[color:var(--s-ink-2)]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DownloadButton({ status, label, primary = false }: { status: TargetStatus; label: string; primary?: boolean }) {
  const cls = `s-btn ${primary ? "s-btn-primary" : "s-btn-ghost"}`;
  if (!status.available) {
    return (
      <span className={cls} aria-disabled="true" title="Not available for download yet">
        {label}
        <span className="sr-only"> (not available yet)</span>
      </span>
    );
  }
  return (
    <a href={status.href} className={cls}>
      {label}
    </a>
  );
}

function Unpublished({ what }: { what: string }) {
  return <p className="s-small mt-4">{what}</p>;
}
