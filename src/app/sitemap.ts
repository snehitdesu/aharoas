import type { MetadataRoute } from "next";
import { MODULES } from "@/site/content";
import { SITE_URL } from "@/site/config";

/** Public website pages only; the operator application is never listed. */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["", "/product", ...MODULES.map((m) => `/product/${m.slug}`), "/solutions", "/download", "/resources", "/resources/release-notes", "/security"];
  return pages.map((p) => ({ url: `${SITE_URL}${p}`, changeFrequency: "monthly", priority: p === "" ? 1 : p.startsWith("/product") ? 0.8 : 0.6 }));
}
