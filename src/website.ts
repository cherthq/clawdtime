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
    title: "ClawdTime | Talk to your Mac. It does the work.",
    description:
      "ClawdTime is a free assistant for your Mac. Ask by chat or by voice, and it uses your apps and your browser for you. Download for Mac or install with one command.",
  },
  "/pricing": {
    file: "pricing.html",
    title: "Pricing | ClawdTime",
    description:
      "ClawdTime is free to download and use. You pay your model provider for what you use. Paid plans for phone calls are planned and not on sale.",
  },
  "/integrations/codex": {
    file: "codex.html",
    title: "Use ClawdTime with Codex | ClawdTime",
    description:
      "See your Codex sessions in ClawdTime, answer their approval requests from the chat, and start a coding session for a job.",
  },
  "/integrations/claude-code": {
    file: "claude-code.html",
    title: "Use ClawdTime with Claude Code | ClawdTime",
    description:
      "See your Claude Code sessions in ClawdTime, answer their permission requests from the chat, and start a coding session for a job.",
  },
  "/guides/getting-started": {
    file: "getting-started.html",
    title: "Setup guide | ClawdTime",
    description:
      "Install ClawdTime with the Mac app or with one command. Each way has numbered steps and runs the same setup.",
  },
  "/privacy": {
    file: "privacy.html",
    title: "Privacy and control | ClawdTime",
    description:
      "What ClawdTime keeps on your Mac, what goes to your model provider, how to stop it, and what the website counts.",
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
    <meta property="og:image:alt" content="ClawdTime. Talk to your Mac. It does the work." />
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
