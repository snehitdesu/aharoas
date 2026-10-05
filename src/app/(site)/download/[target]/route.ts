import { NextResponse, type NextRequest } from "next/server";
import { TARGETS, artifactUrl, type TargetKey } from "@/site/release";

// Read RESTORA_DOWNLOAD_BASE_URL per request: the release host can be changed
// without rebuilding the website.
export const dynamic = "force-dynamic";

/** /download/<target> → 302 to the published artifact, or back to /download when it is not published. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  if (!Object.hasOwn(TARGETS, target)) return new NextResponse("Not found", { status: 404 });
  const url = artifactUrl(target as TargetKey);
  if (!url) {
    const back = req.nextUrl.clone();
    back.pathname = "/download";
    back.search = `?unavailable=${encodeURIComponent(target)}`;
    return NextResponse.redirect(back, 302);
  }
  return NextResponse.redirect(url, 302);
}
