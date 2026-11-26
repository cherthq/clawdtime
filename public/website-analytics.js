// Optional, first-party aggregate counts. Never run on operational pages.
(() => {
  const paths = new Set([
    "/",
    "/pricing",
    "/privacy",
    "/integrations/codex",
    "/integrations/claude-code",
    "/guides/getting-started",
  ]);
  if (
    document.body.dataset.websiteAnalytics !== "on" ||
    !paths.has(location.pathname) ||
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === "1" ||
    navigator.webdriver === true ||
    /bot|crawler|spider|headless/i.test(navigator.userAgent)
  )
    return;

  // Classify transiently; no raw referrer, query, hash or hostname is submitted.
  let channel = "direct";
  try {
    const hostname = new URL(document.referrer).hostname;
    if (hostname !== location.hostname) {
      if (
        /(^|\.)(chatgpt\.com|chat\.openai\.com|claude\.ai|perplexity\.ai|copilot\.microsoft\.com|gemini\.google\.com)$/.test(
          hostname,
        )
      )
        channel = "ai";
      else if (
        /(^|\.)(google\.(com|co\.uk|ca)|bing\.com|duckduckgo\.com|search\.yahoo\.com)$/.test(
          hostname,
        )
      )
        channel = "search";
      else if (
        /(^|\.)(linkedin\.com|x\.com|t\.co|twitter\.com|reddit\.com|facebook\.com)$/.test(
          hostname,
        )
      )
        channel = "social";
      else channel = "referral";
    }
  } catch {
    /* No usable referrer: leave attribution unknown/direct. */
  }
  const availability =
    document.body.dataset.availability === "invited" ? "invited" : "preview";
  const sent = new Set();
  const send = (event, extra = {}) => {
    const key = [event, extra.placement, extra.action].join(":");
    if (sent.has(key)) return;
    sent.add(key);
    // No retry: a lost response can already have been counted.
    void fetch("/api/website/events", {
      method: "POST",
      mode: "same-origin",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        path: location.pathname,
        channel,
        availability,
        ...extra,
      }),
    }).catch(() => {});
  };
  const view = () => {
    if (document.visibilityState === "visible") send("landing_view");
  };
  view();
  document.addEventListener("visibilitychange", view);
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-metric-action]");
    if (!link) return;
    const action = link.dataset.metricAction;
    if (!["availability", "setup", "guide"].includes(action)) return;
    const placement = link.closest(".site-header")
      ? "header"
      : link.closest(".hero")
        ? "hero"
        : link.closest("#availability")
          ? "availability"
          : link.closest(".site-footer, .final-cta")
            ? "footer"
            : "content";
    send("pilot_cta_clicked", { action, placement });
  });
})();
