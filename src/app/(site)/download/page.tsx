import type { Metadata } from "next";
import Link from "next/link";
import { PlatformDownload } from "@/site/components/PlatformDownload";
import { TARGETS, downloadState, formatSize, release, type TargetKey } from "@/site/release";
import { WEB_APP_PATH } from "@/site/config";

export const metadata: Metadata = {
  title: "Download",
  description: "Download RESTORA for Windows, or open RESTORA Web in the browser. Release version, file sizes, checksums and system requirements.",
  alternates: { canonical: "/download" },
};

// Availability depends on RESTORA_DOWNLOAD_BASE_URL at request time (see src/site/release.ts).
export const dynamic = "force-dynamic";

export default async function DownloadPage({ searchParams }: { searchParams: Promise<{ unavailable?: string }> }) {
  const dl = downloadState();
  const { unavailable } = await searchParams;
  const missing = unavailable && Object.hasOwn(TARGETS, unavailable) ? TARGETS[unavailable as TargetKey].label : null;
  const built = (Object.keys(TARGETS) as TargetKey[]).filter((k) => TARGETS[k].artifact);

  return (
    <>
      <section aria-labelledby="download-title" className="pb-16 pt-14 sm:pt-20">
        <div className="s-wrap">
          <p className="s-eyebrow">Download</p>
          <h1 id="download-title" className="s-display mt-5">
            Get RESTORA<span className="s-accent">.</span>
          </h1>
          <p className="s-lead mt-8 max-w-2xl">Bring the restaurant operating system to your desktop, or use it in the browser with nothing to install.</p>
          {missing && (
            <p role="status" className="s-draft mt-8 max-w-3xl">
              The {missing} download is not published yet. The options that are available are below.
            </p>
          )}
          <div className="mt-12">
            <PlatformDownload {...dl} webHref={WEB_APP_PATH} />
          </div>
        </div>
      </section>

      <section aria-labelledby="which-title" className="s-section s-band">
        <div className="s-wrap grid gap-12 lg:grid-cols-2 lg:gap-20">
          <div>
            <h2 id="which-title" className="s-h2">
              Desktop or web?
            </h2>
            <p className="s-lead mt-6">Both run the same RESTORA. The difference is where the data lives.</p>
          </div>
          <dl className="grid gap-8">
            <div className="border-t border-[color:var(--s-rule-strong)] pt-5">
              <dt className="s-h4 text-xl">RESTORA for Windows</dt>
              <dd className="s-body mt-2">A complete RESTORA on one computer: the app, its server and an embedded database, all local. Good for a single counter, and it keeps billing, the kitchen display and inventory working without an internet connection. Data stays on that computer, with verified backups you can restore.</dd>
            </div>
            <div className="border-t border-[color:var(--s-rule-strong)] pt-5">
              <dt className="s-h4 text-xl">RESTORA Web</dt>
              <dd className="s-body mt-2">Runs on a server with PostgreSQL. Every device signs in through the browser: POS terminals, the kitchen display, captains&apos; and managers&apos; phones and guests ordering by QR.</dd>
            </div>
          </dl>
        </div>
      </section>

      <section id="requirements" aria-labelledby="req-title" className="s-section scroll-mt-16">
        <div className="s-wrap">
          <h2 id="req-title" className="s-h2">
            System requirements
          </h2>
          <div className="mt-12 grid gap-12 lg:grid-cols-3">
            <div>
              <h3 className="s-h4 text-xl">Windows</h3>
              <ul className="s-ticks mt-4">
                <li>Windows 10 or 11, 64-bit (x64). Tested on Windows 11.</li>
                <li>About 130 MB download; the installer lets you choose the folder.</li>
                <li>Data in your user profile; it survives updates and uninstall.</li>
                <li>Network ESC/POS printers on the same network, optional.</li>
              </ul>
            </div>
            <div>
              <h3 className="s-h4 text-xl">macOS</h3>
              <ul className="s-ticks mt-4">
                <li>Separate builds for Apple Silicon and Intel Macs.</li>
                <li>Not released yet: the build has not been verified on a Mac.</li>
              </ul>
            </div>
            <div>
              <h3 className="s-h4 text-xl">Web</h3>
              <ul className="s-ticks mt-4">
                <li>A modern browser on a computer, tablet or phone. Tested in Chromium-based browsers.</li>
                <li>Server: Node.js with PostgreSQL 16, one app instance behind HTTPS.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="release-title" className="s-section s-band">
        <div className="s-wrap">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="s-eyebrow">Current release</p>
              <h2 id="release-title" className="s-h2 mt-4 s-num">
                {release.version}
              </h2>
            </div>
            <Link href="/resources/release-notes" className="s-link text-lg">
              Release notes <span className="s-arrow" aria-hidden>→</span>
            </Link>
          </div>
          <p className="s-body mt-6 max-w-3xl">This is a release candidate. The Windows installer is not code-signed yet, so Windows SmartScreen may warn before it runs. Check the file against its SHA-256 checksum below.</p>
          {built.length > 0 ? (
            <div className="mt-10 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-[0.9375rem]">
                <caption className="sr-only">Release files and checksums</caption>
                <thead className="text-sm text-[color:var(--s-muted)]">
                  <tr className="border-b border-[color:var(--s-rule-strong)]">
                    <th scope="col" className="py-3 pr-6 font-medium">File</th>
                    <th scope="col" className="py-3 pr-6 font-medium">Platform</th>
                    <th scope="col" className="py-3 pr-6 font-medium">Size</th>
                    <th scope="col" className="py-3 font-medium">SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {built.map((k) => {
                    const a = TARGETS[k].artifact!;
                    return (
                      <tr key={k} className="border-b border-[color:var(--s-rule)] align-top">
                        <td className="py-4 pr-6 font-medium text-[color:var(--s-ink)]">{a.file}</td>
                        <td className="py-4 pr-6">{TARGETS[k].label}</td>
                        <td className="s-num py-4 pr-6">{formatSize(a.bytes)}</td>
                        <td className="py-4 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">{a.sha256}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="s-body mt-8">No desktop build has been recorded for this release yet.</p>
          )}
        </div>
      </section>
    </>
  );
}
