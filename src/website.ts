import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { publicPage } from "./public-page.js";

export const websiteOrigin = "https://www.clawdtime.com";
/** The one install command. The website serves the script that it pipes to sh. */
export const installCommand = `curl -fsSL ${websiteOrigin}/install.sh | sh`;
/** The disk image of the newest release, under a name that every release keeps. */
export const macDownloadUrl =
  "https://github.com/cherthq/clawdtime/releases/latest/download/ClawdTime-arm64.dmg";
/** What ClawdTime is, in one line: the homepage title, its description, the hero and the README. */
export const ambitionLine =
  "ClawdTime: a computer use agent you can FaceTime. Built on Chert.";
/**
 * The install command for a coding agent. The installer starts the setup when
 * it can read a terminal, and the setup asks for a key: a coding agent must
 * never start it, so the agent's command turns the setup off.
 */
export const agentInstallCommand = `curl -fsSL ${websiteOrigin}/install.sh | CLAWDTIME_NO_ONBOARD=1 sh`;
/**
 * The prompt that a person gives to a coding agent. The agent installs
 * ClawdTime. The person runs the setup, so the agent never sees a key. The
 * homepage, the setup guide and the README show these exact words.
 */
export const agentInstallPrompt = `Install ClawdTime on this Mac. ClawdTime is a computer use agent. It uses the apps and the browser on this Mac for me.

1. Check that this Mac has Apple silicon and macOS 14 or later. If it does not, stop and tell me.
2. Run this command in your shell. It installs ClawdTime and does not start the setup:
   ${agentInstallCommand}
3. Do not run clawdtime onboard or clawdtime keys yourself. Never ask me for a key.
4. Tell me to open Terminal and run this command there:
   clawdtime onboard
   If the installer printed a command that adds clawdtime to PATH, tell me to run that command first.
   The setup asks for my model key at a hidden prompt. It also asks for macOS permissions that only I can give.`;
/** The full path of the command inside the Mac app, for a shell that has no clawdtime command. */
export const appCommandPath =
  "/Applications/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime";
/**
 * The prompt that tells a coding agent how to hand tasks to ClawdTime. The
 * last screen of the Mac app's setup copies the same words, with the path of
 * its own command.
 */
export const agentUsePrompt = `ClawdTime runs on this Mac. It is a computer use agent. It uses the apps and the browser on this Mac for me.

To give ClawdTime a task, run this in your shell: clawdtime chat "TASK"
For example: clawdtime chat "Open Stonepad and make a note: buy milk."
ClawdTime answers in the shell. It can use the screen to do the task.

To see the coding agent sessions on this Mac, and which one waits for an answer, run:
clawdtime agents

To see every command, run: clawdtime help

Give ClawdTime one task at a time. If a command fails, show me its output. Never ask me for a key.
Now run clawdtime agents once, to check that the command works.
If your shell does not find clawdtime, use the full path: ${appCommandPath}`;
export const websitePages = {
  "/": {
    file: "index.html",
    title: ambitionLine,
    description: `${ambitionLine} Talk to your Mac by chat or by voice. It uses your apps and your browser for you. Free for Mac.`,
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
