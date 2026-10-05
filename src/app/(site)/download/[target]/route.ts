import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { TARGETS, artifactUrl, localArtifactPath, type TargetKey } from "@/site/release";

// Read RESTORA_DOWNLOAD_BASE_URL per request: the release host can be changed
// without rebuilding the website.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  ".exe": "application/vnd.microsoft.portable-executable",
  ".dmg": "application/x-apple-diskimage",
};

/**
 * /download/<target> → 302 to the published artifact, or back to /download when it is not published.
 * Under `next dev` with no release host, streams the local build from dist-desktop/ instead.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  if (!Object.hasOwn(TARGETS, target)) return new NextResponse("Not found", { status: 404 });
  const key = target as TargetKey;
  const url = artifactUrl(key);
  if (url) return NextResponse.redirect(url, 302);

  const local = localArtifactPath(key);
  if (local) return serveLocal(local);

  const back = req.nextUrl.clone();
  back.pathname = "/download";
  back.search = `?unavailable=${encodeURIComponent(target)}`;
  return NextResponse.redirect(back, 302);
}

function serveLocal(file: string): Response {
  const name = path.basename(file);
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    return new NextResponse(`Installer not found: dist-desktop/${name}. Build it with npm run desktop:dist.`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const ext = path.extname(name).toLowerCase();
  const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
