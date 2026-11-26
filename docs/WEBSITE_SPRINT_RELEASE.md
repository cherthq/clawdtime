# Landing-page first sprint

November 13, 2026. Local implementation of the [approved plan](LANDING_PAGE_SEO_AEO_GEO_PLAN.md). **Uncommitted, unstaged and not deployed.** Existing unrelated work on the `improvements` checkout is preserved.

## Delivered

- Kept the existing paper/green landing-page design; clarified the product, invitation-only access, requirements and tested integration status.
- Changed the primary CTA to pilot availability. The invited CTA opens the public setup guide in preview mode; only the existing explicitly enabled live-texting configuration substitutes a Messages draft.
- Replaced the skipped-test illustration with a headline choice. The demonstration remains labeled illustrative, not a recording or physical acceptance claim.
- Added distinct `/integrations/codex`, `/integrations/claude-code`, `/guides/getting-started` and `/privacy` pages. Reconciled `/pricing` with proposed, unavailable offers.
- Added a shared metadata renderer, canonical links, Open Graph/Twitter previews, a 1200×630 PNG, favicon, factual WebSite/WebPage/breadcrumb JSON-LD, `/robots.txt` and `/sitemap.xml`.
- Kept operational `/setup`, `/pair` and `/agents` out of the sitemap and marked them `noindex,nofollow`; none loads the analytics script.
- Added optional first-party aggregate measurement, with a protected report. No new dependency, external analytics vendor, cookie, visitor identifier or session replay.

## Local preview

From this checkout, run:

```sh
node_modules/.bin/tsx scripts/preview-website.ts
```

Open `http://127.0.0.1:3337`. `CLAWDTIME_PREVIEW_PORT` can select another port.
The script supplies an explicit simulation configuration, uses an in-memory database and does not run transport polling. It does not read installed live configuration or contact a handset. Counts disappear when stopped.

The preview script has a clearly labeled disposable operator credential for local QA. Never reuse it in hosted configuration. The production application continues to require its existing configured operator credential for reports.

Regenerate the social card on macOS with `swift scripts/create-social-card.swift`.

## Measurement and privacy contract

`CLAWDTIME_WEBSITE_ANALYTICS_ENABLED=true` enables the collector and public-page instrumentation. Omitted or false means no browser events or analytics table creation. The preview explicitly enables it for disposable QA. No hosted environment variable was changed.

Public browser events:

| Event               | Meaning                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `landing_view`      | One visible page view per document load, on one of the six public routes                                           |
| `pilot_cta_clicked` | One selected action/placement combination per document load; not a submitted form, sent message or completed setup |

The server accepts only fixed enums for event, public path, per-page referrer category, availability, placement and action. It rejects extra keys and operational paths. The browser classifies a referrer transiently; it never sends a full referrer, hostname, query or fragment. There is no persistent acquisition attribution across pages. Internal navigation normally loses the original source under the site's `no-referrer` policy. `direct` also includes unavailable referrers.

Collection honors browser GPC/DNT signals and recognized bot/automation user agents. Counts remain untrusted browser signals; bot filtering does not prove human activity. No automatic retry occurs after an ambiguous network response. Repeated clicks within a document are deduplicated locally, but reloads count as new views. There is no cross-device or server-side visitor deduplication.

`POST /api/website/events` requires same-public-origin JSON, limits bodies to 1 KiB, and caps accepted writes at 120 per minute per server instance. Excess events are dropped with 429. The fixed limit can undercount a burst; these are directional counts, not billing or audit records. Raw request bodies, IP addresses, messages, tokens, phone numbers, project paths and screen/audio content are not stored by this collector. Hosting/access logs have their own configuration and should not be assumed absent.

Daily counts live in the existing protected database's separate `website_metrics_daily` table. Reports use **UTC**, default to 28 inclusive calendar days, and accept 1–90 days. Old count rows are pruned on the next accepted event or report; no background deletion task was added. The collector cannot alter authorization, call, receipt or cursor state. A measurement failure does not fail a marketing-page load or operational action.

Read `GET /api/operator/website-metrics?days=28` with the existing operator bearer credential, using the team's protected request tooling. Never put a live token in a URL, public command snippet or browser page. The response is aggregate JSON and is not a public dashboard.

The authenticated report also includes a separate read-only `operational` section, grouped in SQL by UTC date and count. It counts pairing records created, setup-test invitations created after pairing/readiness (including retries), and verified legacy v1 tests. These are not unique people or acquisition-attributed conversions. The source records do not distinguish simulation from live mode, and legacy verification is not current v2 acceptance. The query returns no identities or private record bodies and changes no operational records. An unavailable operational query is explicitly marked unavailable while browser counts remain usable. Disabling measurement also disables this report.

The planned current-pilot activation funnel is not yet a fully attributable dataset. A website click cannot be matched to an iMessage sender by assumption, and no browser payload can claim `pairing_completed` or `first_pilot_loop_verified`. Current call-connection records do not retain an immutable first-connection timestamp; the legacy setup verifier does not qualify the newer protocol. Keep unavailable milestones unavailable, not zero. New evidence semantics and consented attribution would be a separate scoped change.

## Hosting behavior

Canonical URLs use `https://www.clawdtime.com`. The existing apex permanent redirect is a hosting setting and was not changed.

The Hono server receives HTTP behind Railway TLS termination. Canonical indexability compares the request URL's exact **host**, rather than treating its internal HTTP scheme as the public scheme. Marketing HTML on a service alias is `noindex,follow` with the public canonical; APIs and callbacks are never redirected. Forwarded-host headers do not establish the canonical host.

Browser collection requires the exact canonical HTTPS `Origin` and matching request host, or the explicitly configured local simulation origin/host. The narrowly scoped public website-event origin exception does not relax origin policy for pairing, control, session or other APIs. Alias pages do not enable browser collection.

The sitemap lists the six indexable public pages only. It deliberately omits private setup, pairing, the plain-text operational instructions and guessed modification dates. `robots.txt` allows public pages/assets and disallows API/health crawling; operational HTML remains crawlable so its `noindex` can be seen. Authentication, not robots directives, protects private data.

## Search and distribution baseline

Read-only checks on November 13:

| Check                                                | Result / next step                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Search Console through the connected OpenSEO account | No properties available. Verify ownership of `clawdtime.com` and connect the intended account before collecting impressions/clicks or requesting indexing. Do not reuse Chert's property.                                            |
| OpenSEO project inventory                            | Only Chert was established during planning; no ClawdTime tracker or recurring run has been configured.                                                                                                                               |
| Bing Webmaster Tools                                 | No connected ClawdTime property verified; owner verification and baseline remain outstanding.                                                                                                                                        |
| Public GitHub repository                             | `cherthq/clawdtime` is public, but repository homepage/description are null and topics are empty. Website now links to the actual source. Metadata updates remain a proposed external follow-up, not made in this local-only sprint. |
| Production SEO baseline from planning                | Homepage/pricing respond 200; apex permanently redirects; robots/sitemap returned 404; canonical/social metadata absent. Source implementation fixes these only after a later deployment.                                            |
| Search rankings, AI citations and conversion lift    | Unknown. No invented zero baseline, keyword-volume estimate or ranking promise.                                                                                                                                                      |

The weekly scorecard should compare page counts and clicks with verified search data after it is connected. AI prompt-panel checks and paid/scheduled tracking have not been started. Keep neutral discoverability prompts separate from branded accuracy checks as specified in the plan.

## Validation

Focused regression tests cover metadata, structured data, local links/assets, sitemap, real HTTP proxy handling, API isolation, active/preview CTA gating, data minimization, disabled tracking, GPC/DNT/bot handling, authentication, retention, rate bounds and storage failure. Synthetic records only.

Browser QA uses the in-app browser against the isolated local preview. Checked the homepage, setup guide, both integration pages, pricing and privacy at 390px width without document overflow; inspected the desktop hero, availability CTA, setup navigation, privacy deep link and demo pause. Browser view/click events appeared in the protected aggregate report. No browser warnings/errors were observed. Preview screenshots are local under `artifacts/website-sprint/` and are not source deliverables.

Validation: `npm run check` passes type checking, all **752 tests across 48 files**, and the production build. `git diff --check` also passes. No real calls, screen-control trials, provider messages, production deployment, Search Console submission or external profile edits are part of this verification.

## Before a later deployment

1. Review the working-tree diff alongside the unrelated 0.3.0 work; deploy only an explicitly selected, reviewed release.
2. Confirm the canonical public host and existing live-texting gates. A marketing release must not enable traffic or transfer live-line ownership.
3. Decide whether to enable first-party counts and verify the protected report. Leave off if not wanted.
4. Confirm pilot facts and invitation instructions remain current. A public intake form needs a real monitored destination; none was invented here.
5. After a separately authorized deployment, verify response headers/routes on the actual host, then connect Search Console/Bing and submit the sitemap. Local checks do not establish indexing or ranking.
