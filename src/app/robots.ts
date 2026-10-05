import type { MetadataRoute } from "next";
import { SITE_URL } from "@/site/config";
import { PROTECTED_PAGES } from "@/middleware";

/** Index the public website; keep crawlers out of the API, the operator app and guest links. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/login", "/forgot-password", "/set-password", "/t/", "/o/", ...PROTECTED_PAGES] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
