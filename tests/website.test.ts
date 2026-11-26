import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { request as httpRequest } from "node:http";
import { serve } from "@hono/node-server";
import { createRuntime } from "../src/runtime.js";
import { createApp } from "../src/app.js";
import { HumanRouter } from "../src/control/human-router.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { websiteOrigin, websitePages } from "../src/website.js";
import { WEBSITE_PUBLIC_PATHS } from "../src/storage/website-metrics.js";

const operator = "website-test-operator-not-a-real-secret";
const runtimes: ReturnType<typeof createRuntime>[] = [];
const fixture = (enabled = true) => {
  const runtime = createRuntime({
    CLAWDTIME_MODE: "simulation",
    CLAWDTIME_DATABASE: ":memory:",
    CLAWDTIME_ORIGIN: websiteOrigin,
    CLAWDTIME_OPERATOR_TOKEN: operator,
    CLAWDTIME_WEBSITE_ANALYTICS_ENABLED: String(enabled),
  });
  runtimes.push(runtime);
  return runtime;
};
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.store.close();
});
const payload = {
  event: "landing_view",
  path: "/",
  channel: "direct",
  availability: "preview",
};
const post = (
  runtime: ReturnType<typeof fixture>,
  body: unknown = payload,
  headers: Record<string, string> = {},
) =>
  runtime.app.request(`${websiteOrigin}/api/website/events`, {
    method: "POST",
    headers: {
      origin: websiteOrigin,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const report = (runtime: ReturnType<typeof fixture>, query = "") =>
  runtime.app.request(`/api/operator/website-metrics${query}`, {
    headers: { authorization: `Bearer ${operator}` },
  });

describe("public website discovery and isolation", () => {
  it("renders six distinct canonical pages, share metadata and consistent structured data", async () => {
    const runtime = fixture();
    expect(Object.keys(websitePages).sort()).toEqual(
      [...WEBSITE_PUBLIC_PATHS].sort(),
    );
    for (const path of Object.keys(websitePages)) {
      const response = await runtime.app.request(path);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
      expect(response.headers.get("content-security-policy")).not.toContain(
        "unsafe-inline",
      );
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html.match(/<title>/g)).toHaveLength(1);
      expect(html).toContain(`rel="canonical" href="${websiteOrigin}${path}"`);
      expect(html).toContain('property="og:image"');
      expect(html).toContain('name="twitter:card"');
      expect(html).not.toContain("WEBSITE_METADATA");
      const schema = JSON.parse(
        html.match(
          /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
        )![1]!,
      );
      expect(
        schema["@graph"].find(
          (item: Record<string, unknown>) => item["@type"] === "WebPage",
        ).url,
      ).toBe(websiteOrigin + path);
      expect(JSON.stringify(schema)).not.toMatch(
        /"Offer"|aggregateRating|"price"/,
      );
      // Every local page/asset reference resolves; fragment targets checked in browser QA.
      for (const match of html.matchAll(
        /(?:href|src)="(\/[^"#]*)(?:#[^"]*)?"/g,
      )) {
        const target = await runtime.app.request(match[1]!);
        expect(target.status, `${path} links to ${match[1]}`).toBe(200);
      }
    }
    expect((await runtime.app.request("/missing-guide")).status).toBe(404);
    const image = await runtime.app.request("/assets/social-card.png");
    expect(image.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await image.arrayBuffer());
    const dimensions = new DataView(bytes.buffer);
    expect(dimensions.getUint32(16)).toBe(1200);
    expect(dimensions.getUint32(20)).toBe(630);
  });

  it("indexes canonical live marketing HTML but excludes aliases without redirecting APIs", async () => {
    const runtime = fixture();
    const control = new ControlCoordinator(
      runtime.store,
      new SimulatedDevice(),
    );
    const app = createApp(
      runtime.service,
      control,
      new HumanRouter(runtime.service, control),
      {
        origin: websiteOrigin,
        simulation: false,
        dispatchEnabled: false,
      },
    );
    expect(
      (await app.request(websiteOrigin + "/")).headers.get("x-robots-tag"),
    ).toBeNull();
    const alias = await app.request("https://fixture-railway.example/");
    expect(alias.status).toBe(200);
    expect(alias.headers.get("x-robots-tag")).toBe("noindex, follow");
    expect(alias.headers.get("link")).toContain(websiteOrigin);
    const health = await app.request("https://fixture-railway.example/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("location")).toBeNull();
  });

  it("exposes a canonical-only sitemap and keeps operational routes untracked and noindex", async () => {
    const runtime = fixture();
    const robots = await (await runtime.app.request("/robots.txt")).text();
    expect(robots).toContain(`Sitemap: ${websiteOrigin}/sitemap.xml`);
    expect(robots).toContain("Allow: /");
    expect(robots).not.toContain("Disallow: /pair");
    const response = await runtime.app.request("/sitemap.xml");
    expect(response.headers.get("content-type")).toContain("application/xml");
    const xml = await response.text();
    expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])).toEqual(
      Object.keys(websitePages).map((path) => websiteOrigin + path),
    );
    for (const path of ["/pair", "/setup", "/agents"]) {
      const response = await runtime.app.request(path);
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(await response.text()).not.toContain("website-analytics.js");
      expect(xml).not.toContain(`<loc>${websiteOrigin}${path}</loc>`);
    }
    expect(runtime.store.effects()).toHaveLength(0);
  });
});

describe("first-party measurement boundary", () => {
  it("handles HTTPS terminated at a proxy without trusting forwarded hosts", async () => {
    const runtime = fixture();
    const control = new ControlCoordinator(
      runtime.store,
      new SimulatedDevice(),
    );
    const app = createApp(
      runtime.service,
      control,
      new HumanRouter(runtime.service, control),
      {
        origin: "https://fixture-service.example",
        simulation: false,
        dispatchEnabled: false,
        websiteAnalyticsEnabled: true,
        operatorToken: operator,
      },
    );
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const upstream = (
      path: string,
      method: string,
      headers: Record<string, string>,
    ) =>
      new Promise<{
        status: number;
        headers: import("node:http").IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          { hostname: "127.0.0.1", port: address.port, path, method, headers },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += String(chunk);
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                body,
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(method === "POST" ? JSON.stringify(payload) : undefined);
      });
    try {
      const canonical = await upstream("/", "GET", {
        host: "www.clawdtime.com",
      });
      expect(canonical.status).toBe(200);
      expect(canonical.headers["x-robots-tag"]).toBeUndefined();
      expect(canonical.body).toContain('data-website-analytics="on"');
      expect(
        (
          await upstream("/api/website/events", "POST", {
            host: "www.clawdtime.com",
            origin: websiteOrigin,
            "content-type": "application/json",
            "x-forwarded-proto": "https",
          })
        ).status,
      ).toBe(202);
      const alias = await upstream("/", "GET", {
        host: "fixture-service.example",
        "x-forwarded-host": "www.clawdtime.com",
      });
      expect(alias.headers["x-robots-tag"]).toBe("noindex, follow");
      expect(alias.body).toContain('data-website-analytics="off"');
      expect(
        (
          await upstream("/api/website/events", "POST", {
            host: "fixture-service.example",
            origin: websiteOrigin,
            "x-forwarded-host": "www.clawdtime.com",
            "content-type": "application/json",
          })
        ).status,
      ).toBe(403);
      const result = await app.request("/api/operator/website-metrics", {
        headers: { authorization: `Bearer ${operator}` },
      });
      expect((await result.json()).rows[0].count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("counts a view/click and exposes only authenticated daily aggregates", async () => {
    const runtime = fixture();
    expect((await post(runtime)).status).toBe(202);
    expect(
      (
        await post(runtime, {
          ...payload,
          event: "pilot_cta_clicked",
          action: "availability",
          placement: "hero",
        })
      ).status,
    ).toBe(202);
    expect(
      (await runtime.app.request("/api/operator/website-metrics")).status,
    ).toBe(401);
    const response = await report(runtime);
    const data = await response.json();
    expect(data.timezone).toBe("UTC");
    expect(data.rows).toHaveLength(2);
    expect(data.operational).toMatchObject({
      available: true,
      timezone: "UTC",
      datasetMixedMode: true,
      attribution: "none",
      rows: [],
    });
    expect(data.operational.coverage.first_pilot_loop_verified).toMatch(
      /^unavailable:/,
    );
    expect(
      data.rows.reduce(
        (sum: number, row: { count: number }) => sum + row.count,
        0,
      ),
    ).toBe(2);
    expect(JSON.stringify(data)).not.toContain(operator);
    expect((await report(runtime, "?days=999999")).status).toBe(400);
  });

  it("rejects private fields, operational paths, cross-origin posts and forged milestones", async () => {
    const runtime = fixture();
    for (const bad of [
      { ...payload, path: "/pair" },
      { ...payload, token: "private-fixture" },
      { ...payload, referrer: "https://private.example" },
      { ...payload, event: "pairing_completed" },
      { ...payload, path: "/?token=private-fixture" },
    ]) {
      const response = await post(runtime, bad);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private");
    }
    expect(
      (await post(runtime, payload, { origin: "https://foreign.example" }))
        .status,
    ).toBe(403);
    expect((await post(runtime, payload, { origin: "" })).status).toBe(403);
    expect(
      (await post(runtime, payload, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (await post(runtime, { ...payload, extra: "x".repeat(2000) })).status,
    ).toBe(413);
    expect((await (await report(runtime)).json()).rows).toHaveLength(0);
    expect(runtime.store.effects()).toHaveLength(0);
    expect(runtime.store.all("pairing")).toHaveLength(0);
  });

  it("honors privacy and bot signals, and disables collection without configuration", async () => {
    const runtime = fixture();
    const privacyHeaders: Record<string, string>[] = [
      { dnt: "1" },
      { "sec-gpc": "1" },
      { "user-agent": "ExampleBot" },
    ];
    for (const headers of privacyHeaders)
      expect((await post(runtime, payload, headers)).status).toBe(204);
    expect((await (await report(runtime)).json()).rows).toHaveLength(0);
    const disabled = fixture(false);
    expect((await post(disabled)).status).toBe(404);
    expect(await (await disabled.app.request("/")).text()).toContain(
      'data-website-analytics="off"',
    );
    const disabledReport = await report(disabled);
    expect(disabledReport.status).toBe(404);
    expect(await disabledReport.json()).not.toHaveProperty("operational");
  });
});

function browserFixture(
  overrides: {
    path?: string;
    enabled?: string;
    nav?: Record<string, unknown>;
    referrer?: string;
  } = {},
) {
  const listeners = new Map<string, (event?: unknown) => void>();
  const requests: { url: string; options: { body: string } }[] = [];
  const doc = {
    body: {
      dataset: {
        websiteAnalytics: overrides.enabled ?? "on",
        availability: "preview",
      },
    },
    visibilityState: "visible",
    referrer:
      overrides.referrer ?? "https://chatgpt.com/?private=not-collected",
    addEventListener: (name: string, callback: (event?: unknown) => void) =>
      listeners.set(name, callback),
  };
  runInNewContext(
    readFileSync(
      new URL("../public/website-analytics.js", import.meta.url),
      "utf8",
    ),
    {
      document: doc,
      location: {
        pathname: overrides.path ?? "/",
        hostname: "www.clawdtime.com",
        search: "?token=private-fixture",
        hash: "#private-fragment",
      },
      navigator: { userAgent: "ordinary-browser", ...overrides.nav },
      URL,
      Set,
      fetch: (url: string, options: { body: string }) => {
        requests.push({ url, options });
        return Promise.resolve({ status: 202 });
      },
    },
  );
  return { requests, listeners };
}

describe("public browser measurement", () => {
  it("sends only fixed dimensions and deduplicates views and repeated clicks within a page", () => {
    const { requests, listeners } = browserFixture();
    listeners.get("visibilitychange")?.();
    const link = {
      dataset: { metricAction: "availability" },
      closest: (selector: string) => selector === ".hero",
    };
    const click = { target: { closest: () => link } };
    listeners.get("click")?.(click);
    listeners.get("click")?.(click);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]!.options.body)).toEqual({
      ...payload,
      channel: "ai",
    });
    expect(JSON.parse(requests[1]!.options.body)).toEqual({
      ...payload,
      channel: "ai",
      event: "pilot_cta_clicked",
      action: "availability",
      placement: "hero",
    });
    expect(JSON.stringify(requests)).not.toContain("private");
    expect(requests[0]!.options).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
    });
  });
  it("never instruments operational paths, disabled pages, privacy opt-outs or automation", () => {
    for (const config of [
      { path: "/pair" },
      { path: "/setup" },
      { enabled: "off" },
      { nav: { globalPrivacyControl: true } },
      { nav: { doNotTrack: "1" } },
      { nav: { webdriver: true } },
      { nav: { userAgent: "SearchBot" } },
    ])
      expect(browserFixture(config).requests).toHaveLength(0);
  });
});
