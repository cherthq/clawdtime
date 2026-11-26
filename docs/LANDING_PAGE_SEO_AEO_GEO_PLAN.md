# ClawdTime landing page: SEO, AEO and GEO plan

Prepared November 13, 2026 (America/New_York). **Approved; the first sprint is implemented locally, uncommitted and undeployed.** See [implementation and verification](WEBSITE_SPRINT_RELEASE.md). Research observations below describe the pre-change baseline.

## Recommended direction

Keep the existing visual identity and the promise **“Your coding agent can FaceTime you.”** Make the product easier to understand, substantiate and try. The first sprint should improve the homepage, publish two useful integration guides, and establish measurement. A large blog or framework migration is unnecessary for this stage.

Three priorities, in order:

1. **Make the homepage a reliable product answer with an honest next step.** Explain who ClawdTime is for, how the call/screen/response workflow works, and what the pilot actually supports.
2. **Create two focused entry pages for Codex and Claude Code.** Give each distinct setup, prerequisites, limitations and evidence; connect them to the homepage and a public getting-started guide.
3. **Measure discovery through successful pilot activation.** Establish search, AI-answer and conversion baselines before expanding content; distinguish a CTA click from a completed setup or observed working call.

These are effort and product-fit priorities, not a traffic forecast. ClawdTime search volumes, rankings, conversion rates and AI citation rates have not been established.

## Scope and evidence

Reviewed the supplied meeting transcript, the complete recommended Chert search plan, [Juno’s homepage](https://junocompanion.com/), its [low-histamine article](https://junocompanion.com/blog/treatments-and-medication/low-histamine-diet), and [Revnu](https://revnu.com/). Also reviewed ClawdTime’s implementation/session plans, current source, README, latest status and release records, live public HTML and response headers. Public checks were made November 13, 2026, around 4 p.m. Eastern.

The meeting and artifact mainly concern **Chert’s API business**. Their keyword volumes, backlink counts, pricing, customer examples and ranking claims are not ClawdTime evidence. They have not been independently re-audited here. ClawdTime’s site is served by the existing Hono/TypeScript backend on Railway, using static HTML/CSS/JavaScript. Chert’s Next.js/Vercel file references do not apply.

OpenSEO’s connected project list contains Chert (`trychert.com`), not ClawdTime. No ClawdTime Search Console, analytics, backlink or AI-tracker data was available through that project list. No project was created, account configuration changed, paid research run, outreach sent or recurring tracking enabled. This is a planning review, not a comprehensive measured ranking audit. The requested deliverable is this local Markdown file.

### What is already working and what needs attention

| Surface                       | Verified observation                                                                                         | Implication                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Homepage `/`                  | HTTP 200; title, description, H1, substantive HTML, native FAQ details, illustrated demo and pilot caveats   | Preserve the readable foundation; no rendering rewrite is justified.                                                                 |
| Domain variants               | Both HTTP and HTTPS apex GET requests redirect with 301 to `https://www.clawdtime.com/`                      | Permanent canonical-host redirect already works. The artifact’s Chert 307 issue does not apply.                                      |
| Homepage metadata             | No canonical link, Open Graph/Twitter preview tags or JSON-LD in fetched HTML                                | Add a preferred URL, share preview and modest factual structured data. These alone do not establish a ranking problem.               |
| `/robots.txt`, `/sitemap.xml` | Both return 404                                                                                              | Add explicit crawl guidance and a sitemap. A missing robots file is not itself a crawl block; a sitemap does not guarantee indexing. |
| Public page inventory         | `/`, `/pricing`, `/setup`, `/pair`, and plain-text `/agents` exist; no guide/blog system in inspected source | Build a small public knowledge section around actual product questions.                                                              |
| `/setup`                      | HTTP 200 with `noindex,nofollow`; operational setup flow                                                     | Keep private/operational setup separate from a new indexable getting-started article. Do not simply remove its restriction.          |
| `/pair`                       | HTTP 200; no robots meta or X-Robots-Tag observed                                                            | Exclude pairing from search and analytics; preserve actual authorization independently of indexing controls.                         |
| Railway service hostname      | Also serves HTML with HTTP 200; no canonical/noindex observed                                                | Consolidate public marketing URLs without redirecting APIs, callbacks or operational paths.                                          |
| Pricing                       | Real page exists, explicitly proposed; approximately $25 and free calls are not active offers                | Reconcile availability language and avoid publishing proposed prices as purchasable structured offers.                               |
| Conversion                    | “Text it” is gated in source; preview mode opens an informational dialog, enabled mode opens Messages        | Make availability clear before the click. Measure each state separately.                                                             |
| Measurement                   | No analytics SDK/event calls found in inspected landing source or fetched HTML                               | Instrument deliberately. This does not prove that infrastructure-level analytics do not exist.                                       |
| Product status                | Deployed pilot and newer uncommitted 0.3.0 source have different evidence                                    | Reconcile public claims against the deployed release; source tests are not physical product acceptance.                              |

No authenticated runtime, customer messages, pairing secrets, screen captures or audio were collected for this plan. Browser and HTTP reading did not place calls or send messages.

## Adapt the examples, with changes for ClawdTime

| Idea from the meeting/examples               | Adaptation                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Juno’s answer-first articles                 | Use a direct answer, named author, checked date, useful steps, evidence, FAQ and related guides. Its article also offers a practical checklist; ClawdTime can offer a plain setup-readiness checklist. |
| Juno’s clear product explanation             | Explain the user’s problem and supported workflow before discussing implementation.                                                                                                                    |
| Revnu’s product/solution/resource navigation | Start with Integrations, Guides, Demo, Pricing and Privacy. Add only pages with distinct useful content.                                                                                               |
| Correct outdated third-party descriptions    | Audit actual ClawdTime mentions, then request factual corrections with a supporting public URL. Do not reuse Chert’s eight-page outreach list as a ClawdTime list.                                     |
| Earn links through demonstrations            | Publish one consented, accurate demo story; link from relevant owned profiles and real project write-ups.                                                                                              |
| Publish daily                                | Start with two integration guides and one evidence-led guide in the first two weeks. Increase cadence only when quality and demand justify it.                                                         |
| Choose a domain early                        | Keep the established `www.clawdtime.com` address and permanent redirects. No domain purchase or migration is needed for this plan.                                                                     |

The examples demonstrate content structure, not proof that those structures caused growth. Do not transplant Juno’s health topics or Revnu’s broad industry-page footprint.

## Positioning and proposed landing-page content

Initial audience: developers and technical founders who leave coding agents running on a Mac and need to make decisions or inspect work away from their desks.

ClawdTime’s central proposition is **an agent-initiated FaceTime call with visual context and a response returned to the intended workflow**. Chert provides underlying communications infrastructure. Keep that relationship explicit without presenting ClawdTime as a general FaceTime API vendor or implying affiliation with Apple, Anthropic or OpenAI.

A live discovery search surfaced other agent-calling products. For example, [CallMeMCP](https://www.callmemcp.com/) advertises calls and voice replies for coding agents. Therefore, avoid “only agent that calls you” and the current broad “Every AI assistant texts you” comparison. This was qualitative discovery, not a controlled Google rank measurement or competitor feature audit.

### Proposed copy and section order

**Title:** `ClawdTime | FaceTime calls from your coding agent`

**H1:** `Your coding agent can FaceTime you.`

**Subheading:** `Step away from your Mac. When your agent needs a decision, ClawdTime brings the question and screen to your phone, so you can review the work and respond.`

**Adjacent availability line:** `Invited pilot · Mac companion required · See tested agents and current limitations.` Link this line to the compatibility section. Remove “now” where it implies immediate public access.

**Answer block:** `ClawdTime connects a paired coding-agent session to its human through FaceTime and iMessage. The pilot lets an agent request attention, share the selected Mac screen, and receive feedback. Setup requires an invitation, a Mac companion and explicit permissions. Support varies by agent and client surface; the compatibility guide explains what has been verified.`

Final wording must match the released version when implemented.

| Order | Section                | Proposed change                                                                                                                                                                           |
| ----- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Hero and availability  | Preserve visual character; use the copy above and one clear primary CTA.                                                                                                                  |
| 2     | Short demo             | Keep the illustration until a real, approved clip exists. Replace “Skip that test” with a meaningful decision such as choosing a UI variant. Label illustration versus recorded evidence. |
| 3     | What ClawdTime does    | Add the concise answer block in visible HTML.                                                                                                                                             |
| 4     | How it works           | Show invitation → companion and permissions → connect agent → supervised first call. Separate setup from everyday use.                                                                    |
| 5     | Supported agents       | Compact table for Codex and Claude Code: client surface/version, setup link, verified behavior, limitations and checked date. Separate planned integrations.                              |
| 6     | Three useful scenarios | Resolve a blocker, review a UI, discuss a proposed change. Describe supported behavior without promising automatic approval interception.                                                 |
| 7     | Evidence               | One measured pilot story when publishable, with environment, observed outcome and limitations. A demo script is not proof a recording exists.                                             |
| 8     | Privacy and control    | Explain selected-screen access, separate input permission, local Stop and transient media. Avoid broader “nothing is stored” claims that ignore necessary receipts.                       |
| 9     | Availability/pricing   | Explain the invitation process and planned pricing together; remove ambiguity about free trials or purchase readiness.                                                                    |
| 10    | FAQ and next step      | Direct answers with links to setup, compatibility and privacy; repeat the appropriate CTA.                                                                                                |

CTA recommendation: while access is invitation-only, use **“Request pilot access”** for new visitors and **“Invited? Start setup”** for testers. The former requires an actual, monitored intake destination before publication. Until that exists, use **“See pilot availability”** rather than a nonfunctional signup button. An enabled Messages link opens a draft; it does not prove the visitor sent it.

Proposed FAQs: What is ClawdTime? Can Claude Code or Codex call me? Which clients have been tested? Do I need a Mac and iPhone? Can I see the screen? Can I control the Mac? What happens when I do not answer? Can I start a new task by texting? What is stored? How do I get access?

### Publication boundaries

Latest local records describe a limited deployed pilot and a newer, undeployed conversational architecture. Basic speech has been observed, with unresolved latency/reliability limits. Do not market full-duplex conversation, universally seamless voice, unrestricted desktop control, arbitrary idle-chat takeover, public notarized installation or broad agent compatibility as verified. Public pages should describe user-relevant limitations without exposing internal incident records or runtime details.

Keep Codex and Claude Code evidence separate. Do not turn synthetic connector checks into a Claude handset qualification. Keep future Cursor/OpenClaw support out of current-support schema and page titles. Publish no proposed price as an active `Offer`, fabricated review/rating, or unmeasured speed claim.

## First sprint: fastest useful changes

Effort estimates below are planning ranges, assuming existing hosting access and one implementer. Budget **2–3 working days for the foundation**, excluding account verification, external review, indexing delay and physical product qualification.

Spend 30–60 minutes on day one inventorying ClawdTime’s public repository/profile links and relevant existing mentions. Correct owned descriptions once supporting product facts are settled. Earned distribution may bring qualified visitors sooner than new organic rankings; prioritize genuine opportunities without assuming Chert’s event relationships transfer to ClawdTime.

| Priority / timing | Deliverable                                                                       | Effort                                           | Acceptance condition                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| P0 / day 1        | Homepage answer, availability, CTA states and corrected comparisons               | 0.5–1 day                                        | A new visitor can identify the product, prerequisites and actual next step without opening an operational setup page. |
| P0 / days 1–3     | Search baseline and explicit funnel events                                        | 0.5–1 day plus account verification              | Search property belongs to ClawdTime; test events distinguish clicks, requests and completed stages.                  |
| P0 / days 1–3     | Canonicals, sitemap, crawl rules, share metadata and private-page indexing policy | 0.5 day                                          | Public routes return correct HTML/metadata; excluded pages stay out of sitemap; APIs retain existing behavior.        |
| P1 / days 3–5     | Codex and Claude Code pages plus public getting-started guide                     | 1–2 days                                         | Each page answers a distinct intent with accurate prerequisites, evidence and working internal links.                 |
| P1 / week 2       | One demo/story and one answer-led guide                                           | 1–2 days; clip depends on approval/evidence      | Public content uses consented assets and only claims observed outcomes.                                               |
| P1 / week 2       | Relevant owned profiles and earned mentions                                       | 1–2 hours for audit; external responses variable | Names, homepage links and descriptions agree; outreach remains a separately executed task.                            |
| P2 / weeks 3–4    | Improve pages using query and conversion evidence                                 | 1–2 hours per week                               | Each expansion has an observed question or demand signal, unique value and a measurable next step.                    |

### Technical implementation notes

- Retain `public/index.html`, `public/landing.css` and `public/landing.js`. Put route and header changes in the existing public-serving layer of `src/app.ts`; account for `src/public-page.ts` CTA transformation. No new framework or CMS is necessary for the first pages.
- Add absolute self-canonical URLs to indexable pages, unique titles/descriptions, share images and social preview tags. Canonical means the preferred public URL for a page.
- Serve `/robots.txt` and `/sitemap.xml` explicitly. Sitemap entries should include only published, indexable canonical URLs, with truthful modification dates. Add new routes to the build’s asset-copy/route conventions; an HTML file alone does not create a route.
- Preserve `/setup` as an operational route; create `/guides/getting-started` for public explanation. Add `noindex` to `/pair` and other operational HTML as appropriate. Keep them out of analytics and sitemaps. Authentication protects private data; robots directives do not. Do not block a public page from crawling if relying on the crawler seeing its `noindex`. [Google robots guidance](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
- For the Railway alias, use narrowly scoped marketing-page redirects or another consistent canonicalization policy. Do not redirect the entire service hostname, change API origins or break authenticated callbacks.
- Add factual `WebSite`/organization identity and, where useful, `SoftwareApplication` information. Use only profiles representing the same entity in `sameAs`; Chert is not an alias for ClawdTime. Add article/breadcrumb metadata when those pages exist. Structured data must agree with visible content.
- Preserve crawl access to public text and assets. Review actual crawler access and hosting rules, not just user-agent spoof tests. Search inclusion and model training are separate decisions: OpenAI documents independent `OAI-SearchBot` and `GPTBot` controls. Do not enable training access merely to pursue search visibility. [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots)
- Check the current restrictive Content Security Policy before adding analytics or video. Use narrow, deliberate origins or self-hosted assets; do not broadly weaken policy. Keep pairing/token-bearing routes free of third-party scripts and session replay.
- Check mobile layout, keyboard access, reduced motion and asset size. Measure performance before optimizing; no Lighthouse or real-user speed baseline was collected in this review. Keep heavy video lazy-loaded with a poster and transcript.

## Small content plan

The query phrases below are **intent hypotheses**, not measured keywords or ranking promises. Start with US English for a consistent baseline, then adjust to actual audience data. Check Search Console queries and a focused keyword/SERP sample before expanding beyond this set.

| Page                                      | Question / intent                                              | Required unique value                                                                                       | Next action               |
| ----------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| `/`                                       | “ClawdTime”, “coding agent FaceTime”                           | Product definition, availability, visual explanation and supported workflow                                 | Pilot availability/intake |
| `/integrations/codex`                     | “Codex phone notifications”, “Codex FaceTime”, “Codex call me” | Exact tested surface, supported connection process, same-chat versus managed-session boundaries             | Getting-started guide     |
| `/integrations/claude-code`               | “Claude Code call me”, “Claude Code phone notifications”       | Claude-specific setup and an explicit physical-validation status; not a swapped-name copy of the Codex page | Getting-started guide     |
| `/guides/getting-started`                 | “ClawdTime setup”, “ClawdTime Mac requirements”                | Invitation, OS/client prerequisites, installation availability, permissions, success/failure checklist      | Invited setup             |
| `/guides/coding-agent-calls-when-blocked` | “How can my coding agent call when it needs me?”               | Notification vs voice call vs visual review; explicit trigger behavior and missed-call handling             | Relevant integration      |
| `/demo`                                   | “coding agent FaceTime demo”                                   | Approved real clip or clearly labeled illustration, text walkthrough, tested environment and limitations    | Pilot availability        |
| `/privacy`                                | “ClawdTime screen sharing privacy”                             | Accurate data flow, retained metadata versus transient media, Stop/revocation and contact                   | Return to setup           |

Use existing `/pricing`; do not create duplicate pricing content. Add a small `/guides` index when at least two useful guides are published. Link homepage → integrations → getting started; guides → the relevant integration; all public pages → availability and privacy. Prefer descriptive link text over repeated “learn more.”

For each guide: question-led title; author and honest relevant background; published/checked dates; a short self-contained answer; optional takeaways; prerequisites; actual steps or decision table; first-hand evidence; limitations; FAQs; primary references; two related pages; one relevant CTA. Tables and word counts are tools, not required filler. Never publish private setup tokens or undocumented install commands as examples.

Later comparison candidate: **“Coding-agent phone calls vs notifications vs remote desktop.”** Explain which workflow suits which need. A named competitor comparison should follow a fresh feature/source check, disclose ClawdTime’s authorship, and give alternatives credit where appropriate.

## SEO, AEO and GEO: what to prioritize

SEO is search discovery and qualified traffic. AEO is making useful answers easy to extract and attribute. GEO is accurate representation and citation in generated answers. They overlap substantially; this plan treats them as one content/measurement program.

Google says its AI search features use established SEO foundations, require indexing/snippet eligibility, and do not require special AI files or schema. This supports prioritizing accessible content, internal links and useful evidence. [Google AI features guidance](https://developers.google.com/search/docs/appearance/ai-features)

Two current corrections matter: Google states that `llms.txt` does not affect its visibility/rankings, and FAQ rich results stopped appearing on May 7, 2026. Keep useful visible FAQs; do not sell FAQ schema or `llms.txt` as a fast ranking tactic. `/agents` already offers machine-readable setup guidance and should remain accurate. [Google documentation updates](https://developers.google.com/search/updates)

For external visibility, first audit ClawdTime’s real public repository/profile links and relevant developer write-ups. Request truthful attribution where a project actually used ClawdTime. Disclose relationships; allow normal link qualification for sponsorships. Do not require ranking-passing backlinks as a prize condition, publish sham independent comparisons, or mass-produce generic directory pages. [Google spam policies](https://developers.google.com/search/docs/essentials/spam-policies)

Do not borrow the transcript’s guaranteed timeline, domain-rating claims or assumed conversion rate. Third-party authority scores are diagnostics, not the business objective. Referral/hackathon traffic can be valuable; evaluate activation quality instead of dismissing it because it is not organic search.

## Measurement plan

Start with Google Search Console, Bing Webmaster Tools, one product-analytics system and a small weekly scorecard. PostHog is a reasonable option if the team wants to reuse it, but a ClawdTime project/integration has not been verified here. Avoid buying overlapping SEO subscriptions before the baseline exists. An OpenSEO ClawdTime project can be configured later; do not attach this domain to the existing Chert property.

### Funnel and event definitions

| Event / stage                    | Evidence required                                                                    | Reporting meaning                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `landing_view`                   | Public-page visit, with known bots/internal tests separated                          | Eligible human discovery; not a lead                                |
| `pilot_cta_clicked`              | Click, with placement and current availability state                                 | Intent only                                                         |
| `pilot_request_submitted`        | Actual accepted intake submission, when intake exists                                | Lead; never fire on dialog open                                     |
| `setup_started`                  | Real onboarding begins, tied to an eligible invitation                               | Activated onboarding attempt                                        |
| `pairing_completed`              | Authoritative backend completion                                                     | Setup milestone                                                     |
| `first_attention_call_connected` | Confirmed connected call                                                             | Transport milestone; not proof of visible screen or useful feedback |
| `first_pilot_loop_verified`      | Screen/feedback/agent continuation observed under a documented acceptance definition | Primary activation outcome                                          |

Track verified new pilot activations from organic and identifiable AI-referral cohorts. While public admission is closed, use qualified pilot requests as the provisional business outcome and show capacity constraints alongside conversions. Define a fixed attribution window, initially 14 days, and compare acquisition cohorts rather than dividing this week’s completions by this week’s unrelated visitors.

Allowlisted properties: canonical public path, CTA placement, page version, acquisition channel, referrer hostname, approved campaign tags and selected integration. Use a pseudonymous identifier only when appropriate. Never capture message bodies, phone numbers, pairing fragments/tokens, screen/audio content, project paths or arbitrary full URLs. Do not enable autocapture/session replay on setup, pairing or control surfaces.

Operational setup/pairing pages remain excluded from browser tracking. Minimal backend milestones such as `setup_started` and `pairing_completed` can feed aggregate reporting without collecting those pages’ contents, private identifiers or URLs. Implement that boundary explicitly with the transport owner.

Web-to-Messages attribution is a real gap. A click cannot be joined to a later handset message by assumption. Begin with measured clicks and separately reported verified activations; optionally ask how testers found ClawdTime. Add a consented, short-lived non-secret attribution mechanism only if needed, without repurposing authentication tokens. Label unattributed conversions honestly.

### Weekly scorecard

| Layer             | Metric                                                                          | Source / caveat                                                                  |
| ----------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Discoverability   | Intended public URLs submitted, indexed and excluded; Google-selected canonical | Search Console URL inspection; submission is not indexation                      |
| Search            | Non-branded impressions, clicks, CTR and queries by landing page                | Search Console; keep branded terms separate                                      |
| Human conversion  | Requests, starts, pairing, connected calls, verified loops; cohort conversion   | Product analytics + minimal authoritative completion events                      |
| AI referrals      | Human visits and verified conversions with identifiable AI referrers            | Analytics; apps often omit referrers, so this is a lower bound                   |
| AI answer quality | Neutral-prompt mention rate, owned-site citation rate and factual accuracy      | Fixed repeated prompt sample; record engines, date, locale and model/search mode |
| Bing AI citations | Cited pages, citations and grounding-query trends                               | Bing AI Performance, if property access is available; not equivalent to visits   |
| Crawl health      | Public-route fetches, response codes, crawler family and last successful fetch  | Sanitized server/edge aggregates; JS analytics is not a complete bot log         |
| Distribution      | Relevant referring pages and resulting qualified visitors                       | Referral report plus manual verification; not raw domain-rating growth           |

Google’s AI-feature traffic is included in Search Console’s Web reporting; do not label a normal Google click as a proven AI Overview click. Bing’s AI Performance provides its own sampled citation evidence for supported surfaces, not a universal AI ranking. [Google measurement guidance](https://developers.google.com/search/docs/appearance/ai-features), [Bing AI Performance](https://www.bing.com/webmasters/help/ai-performance-9f8e7d6c)

Crawler monitoring should retain route/status/time aggregates, not raw sensitive requests. Where providers offer verification, validate crawler identity before labeling traffic verified; user-agent text alone is only a claim. A fetch does not prove that a page was indexed or cited.

### Initial AI prompt panel

Use five neutral prompts for discoverability and two separate branded prompts for accuracy:

1. How can my coding agent call me when it needs a decision?
2. How can I review an AI coding agent’s screen from my phone?
3. What tools let Claude Code contact me while I am away from my desk?
4. How can I get a phone call from Codex when it needs input?
5. What should I use for remote visual review of a coding agent’s work?
6. What is ClawdTime, and who is it for?
7. Which agents and devices does ClawdTime support, and is it publicly available?

Run in fresh, unseeded sessions with consistent US-English settings on two relevant search-enabled answer engines initially. Repeat each prompt twice per weekly check; record failures separately. Score brand mentioned, owned URL cited, current availability stated correctly and unsupported claims. Neutral mention/citation rates use valid neutral answers as the denominator; branded prompts never inflate discoverability. Store public answer evidence and cited URLs, not private user conversations. Any paid or scheduled tool runs are future setup, not enabled by this document.

Review every Monday, starting November 16, 2026: capture a pre-change baseline, then compare weekly counts and rolling 28-day windows once enough history exists. At low volume, show counts and denominators instead of dramatic percentage changes. Log publication dates so changes can be investigated, without claiming a causal lift from a single before/after result.

## Alternatives considered and sequencing

| Opportunity                                     | Evidence / uncertainty                                                            | Decision                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Homepage clarity and honest CTA                 | Existing promise is strong; availability and pricing need a coherent next step    | First: improves the destination all channels already use.                                                     |
| Integration guides                              | No distinct public Codex/Claude pages; relevant product intent, unmeasured demand | Strongest runner-up. Ship next; needs accurate surface-specific evidence and a useful conversion destination. |
| Crawl/metadata cleanup                          | Directly observed gaps, but no proven indexing loss                               | Bundle into the first sprint; do not forecast traffic from a checklist.                                       |
| Verified demonstration                          | Placeholder exists; documentation contains evidence and a filming plan            | High value after obtaining publishable proof; do not invent a successful clip.                                |
| Owned profiles and earned mentions              | Relevant pattern in the artifact; ClawdTime-specific link gaps not yet audited    | Inspect and correct selectively after supporting public pages exist.                                          |
| Daily blog / large solution grid                | No demand or editorial-capacity baseline                                          | Defer; three useful pieces beat dozens of interchangeable pages.                                              |
| Generic FaceTime/iMessage API and WebRTC topics | Chert’s intent and numbers, not ClawdTime’s product audience                      | Keep with Chert’s strategy; link contextually when helpful.                                                   |
| Broad competitor-pricing pages                  | No ClawdTime-specific demand evidence; pilot offers still provisional             | Defer; start with workflow education and accurate comparisons.                                                |
| `llms.txt`, FAQ schema, domain-rating campaigns | No established mechanism for the promised fast ClawdTime gains                    | Low priority; maintain useful answers and measure real discovery/conversion.                                  |
| Domain/framework redesign                       | Existing brand domain, static HTML and permanent redirect work                    | Preserve; spend effort on answers, evidence and conversion.                                                   |

## Implementation handoff and completion checks

Lead owns `public/`, public routes, root configuration and this plan. Coordinate any backend activation events with the transport owner; connector-specific instructions with the connector owner; Mac requirements and physical-demo claims with the Mac owner. Request shared contract changes through the lead. A marketing sprint must not take ownership of live lines or start qualification calls.

Before implementation, confirm the monitored pilot intake destination, ClawdTime Search Console/Bing ownership, chosen analytics destination, current released compatibility facts and rights to any demo assets. These are concrete implementation dependencies, not blockers to this completed draft.

Completion checks for the later implementation:

- Inspect deployed response HTML and headers for each public, excluded and alias route; validate sitemap and actual 404 behavior.
- Verify metadata and structured data match visible content, dates and availability.
- Check mobile/desktop, keyboard/reduced-motion behavior, share previews and every public link.
- Verify preview and invited CTA states without sending a real message or making a call.
- Verify events and deduplication with synthetic data; confirm private routes/fields are excluded. Native OS message handoff is not a sent-message assertion.
- Run focused route/metadata checks and the required `npm run check` when code changes. Record physical acceptance separately.
- Request indexing only after publishing; record later indexation rather than promising an immediate result.

The initial planning task changed only this document. The subsequently approved first sprint is documented in [the implementation record](WEBSITE_SPRINT_RELEASE.md). Leave all sprint changes **uncommitted and unstaged**. Preserve the existing dirty checkout and its branch; do not switch branches, commit, deploy or modify sibling projects.

## Sources and reproducibility

- User-supplied meeting transcript, November 13. Used for strategic themes; unrelated personal discussion omitted.
- Recommended Chert search plan: read in the browser, including all sections. Its metrics remain attributed, unverified Chert claims.
- [Juno homepage](https://junocompanion.com/) and [article example](https://junocompanion.com/blog/treatments-and-medication/low-histamine-diet): inspected for structure, not medical advice or verified traffic performance.
- [Revnu homepage](https://revnu.com/): inspected for positioning and navigation patterns, not proof of SEO results.
- [ClawdTime](https://www.clawdtime.com/), [pricing](https://www.clawdtime.com/pricing), [setup](https://www.clawdtime.com/setup), [agent instructions](https://www.clawdtime.com/agents), plus robots/sitemap/pair and domain-variant HTTP checks.
- Local evidence: `IMPLEMENTATION_PLAN.md`, `SESSION_PROMPT.md`, `README.md`, `docs/STATUS.md` (newest entries first), `docs/CONVERSATIONAL_CONTROL_RELEASE.md`, `docs/AGENT_OWNED_RELEASE.md`, `docs/FILMED_DEMO.md`, `src/app.ts`, `src/public-page.ts`, `public/` and `package.json`.
- Primary search guidance is linked beside recommendations. Research structure informed by the [OpenSEO SEO Audit skill](https://openseo.so/docs/skills/seo-audit), adapted to the requested local planning scope.

Live page access succeeded through browser/curl where the web reader failed. An initial Python HTTPS client had local trust-store errors across unrelated domains; normal curl/browser access succeeded. Those errors are not evidence of a ClawdTime certificate defect. GET requests, not inconsistent HEAD responses, established the apex redirect status.
