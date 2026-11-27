import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { publicPage } from "./public-page.js";

export const websiteOrigin = "https://www.clawdtime.com";
/** The one install command. The website serves the script that it pipes to sh. */
export const installCommand = `curl -fsSL ${websiteOrigin}/install.sh | sh`;
/** The disk image of the newest release, under a name that every release keeps. */
export const macDownloadUrl =
  "https://github.com/cherthq/clawdtime/releases/latest/download/ClawdTime-arm64.dmg";
export const websitePages = {
  "/": {
    file: "index.html",
    title: "ClawdTime | A computer use agent for your Mac",
    description:
      "ClawdTime works across your Mac apps and browser. Watch the demo, explore guided setup and the native Mac app, and get the latest release.",
  },
  "/pricing": {
    file: "pricing.html",
    title: "Pilot availability and planned pricing | ClawdTime",
    description:
      "ClawdTime is invitation-only. See pilot requirements and proposed pricing. Public subscriptions, free-call allowances and dedicated plans are not yet available.",
  },
  "/integrations/codex": {
    file: "codex.html",
    title: "FaceTime calls from Codex | ClawdTime pilot",
    description:
      "Learn how ClawdTime connects a running Codex session to FaceTime and iMessage, with tested surfaces, Mac requirements and current limitations.",
  },
  "/integrations/claude-code": {
    file: "claude-code.html",
    title: "Claude Code calling integration | ClawdTime pilot",
    description:
      "Explore ClawdTime’s cooperative Claude Code connector: tested client version, invitation-only setup and what still needs live handset validation.",
  },
  "/guides/getting-started": {
    file: "getting-started.html",
    title: "Installation options and shared-number setup | ClawdTime",
    description:
      "Install ClawdTime with guided command setup or the native Mac app. Check early-release limitations and source installation requirements.",
  },
  "/privacy": {
    file: "privacy.html",
    title: "Screen sharing, permissions and data | ClawdTime",
    description:
      "Understand ClawdTime’s screen and control permissions, local Stop, transient media, operational receipts and optional aggregate website measurement.",
  },
} as const;
export type WebsitePath = keyof typeof websitePages;

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function websitePage(
  path: WebsitePath,
  phone?: string,
  analytics = false,
) {
  const page = websitePages[path];
  const canonical = websiteOrigin + path;
  const schema: Record<string, unknown>[] = [
    {
      "@type": "WebSite",
      "@id": `${websiteOrigin}/#website`,
      name: "ClawdTime",
      url: websiteOrigin + "/",
    },
    {
      "@type": "WebPage",
      "@id": canonical,
      url: canonical,
      name: page.title,
      description: page.description,
      isPartOf: { "@id": `${websiteOrigin}/#website` },
    },
  ];
  if (path !== "/")
    schema.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "ClawdTime",
          item: websiteOrigin + "/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: page.title.split(" | ")[0],
          item: canonical,
        },
      ],
    });
  const metadata = `<title>${escape(page.title)}</title>
    <meta name="description" content="${escape(page.description)}" />
    <link rel="canonical" href="${canonical}" />
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ClawdTime" />
    <meta property="og:title" content="${escape(page.title)}" />
    <meta property="og:description" content="${escape(page.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${websiteOrigin}/assets/social-card.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="ClawdTime. A computer use agent for your Mac. Internal pilot." />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escape(page.title)}" />
    <meta name="twitter:description" content="${escape(page.description)}" />
    <meta name="twitter:image" content="${websiteOrigin}/assets/social-card.png" />
    <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": schema }).replaceAll("<", "\\u003c")}</script>`;
  return publicPage(
    readFileSync(
      new URL(`../public/${page.file}`, import.meta.url),
      "utf8",
    ).replace("<!-- WEBSITE_METADATA -->", metadata),
    phone,
    analytics,
  );
}

export function websiteSitemap() {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    Object.keys(websitePages)
      .map((path) => `  <url><loc>${websiteOrigin}${path}</loc></url>`)
      .join("\n") +
    "\n</urlset>\n"
  );
}

export const websiteRobots = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /health

# Operational HTML uses noindex. Crawlers must fetch it to see that directive.
Sitemap: ${websiteOrigin}/sitemap.xml
`;

/**
 * The install script, read again on each request so that a new release is
 * served at once. Plain text, never cached and never indexed.
 */
export function websiteInstallScript(c: Context) {
  let script: string;
  try {
    script = readFileSync(
      new URL("../scripts/install.sh", import.meta.url),
      "utf8",
    );
  } catch {
    return c.notFound();
  }
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.body(script);
}

/** Download for Mac. A temporary redirect, so no browser keeps an old target. */
export function websiteDownload(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.redirect(macDownloadUrl, 302);
}
