document.documentElement.classList.add("js");

const demo = document.querySelector("#call-demo");
if (demo) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const toggle = document.querySelector("#demo-toggle");
  const tabs = [...document.querySelectorAll("[data-demo-scene]")];
  let scene = 0;
  let paused = motion.matches;
  let timer;
  const scenes = [
    {
      status: "NEEDS YOU",
      badge: "REVIEW",
      caption: "A choice to make. Your phone rings.",
      eyebrow: "INCOMING FACETIME",
      subtitle: "A little help over here?",
      output: "A: “Good work doesn’t need a desk.”",
      detail: "B: “Bring your work with you.”",
      agent: "↗ Calling you for a second opinion…",
      mini: "? Choose a headline",
      speech: "“Use the first one.”",
    },
    {
      status: "YOU’RE CONNECTED",
      badge: "REVIEW",
      caption: "See the options. Make the choice.",
      eyebrow: "FACETIME · SCREEN SHARING",
      subtitle: "Your Mac, right here.",
      output: "A: “Good work doesn’t need a desk.”",
      detail: "Waiting for your direction…",
      agent: "→ You: “Use the first one.”",
      mini: "? Choose a headline",
      speech: "“Use the first one.”",
    },
    {
      status: "BACK TO WORK",
      badge: "READY",
      caption: "Unblocked. Back to your day.",
      eyebrow: "FACETIME · SCREEN SHARING",
      subtitle: "Got it. Carrying on.",
      output: "✓ Headline updated in the draft",
      detail: "Your choice. Your agent carries on.",
      agent: "✓ Your agent is carrying on.",
      mini: "✓ First headline selected",
      speech: "“On it. Thanks!”",
    },
  ];
  const setText = (selector, value) => {
    document.querySelector(selector).textContent = value;
  };
  function render() {
    const state = scenes[scene];
    demo.dataset.scene = String(scene);
    setText("#terminal-status", state.status);
    setText("#test-badge", state.badge);
    document.querySelector("#test-badge").className =
      scene === 2 ? "test-badge pass" : "test-badge fail";
    setText("#call-caption", state.caption);
    setText("#caption-number", String(scene + 1).padStart(2, "0"));
    setText("#phone-eyebrow", state.eyebrow);
    setText("#caller-subtitle", state.subtitle);
    const output = document.querySelector("#terminal-output");
    const result = document.createElement("span");
    result.className = scene === 2 ? "code-green" : "error-text";
    result.textContent = state.output;
    const detail = document.createElement("span");
    detail.className = "dim";
    detail.textContent = state.detail;
    output.replaceChildren(result, document.createElement("br"), detail);
    setText("#agent-bubble", state.agent);
    setText("#mini-test", state.mini);
    setText("#speech-sticker span", state.speech);
    tabs.forEach((tab, index) =>
      tab.setAttribute("aria-pressed", String(index === scene)),
    );
    toggle.textContent = paused ? "▶ Play" : "Ⅱ Pause";
    toggle.setAttribute("aria-label", paused ? "Play demo" : "Pause demo");
  }
  function schedule() {
    clearInterval(timer);
    if (!paused && !document.hidden)
      timer = setInterval(() => {
        scene = (scene + 1) % scenes.length;
        render();
      }, 3200);
  }
  toggle.addEventListener("click", () => {
    paused = !paused;
    render();
    schedule();
  });
  tabs.forEach((tab, index) =>
    tab.addEventListener("click", () => {
      scene = index;
      paused = true;
      render();
      schedule();
    }),
  );
  motion.addEventListener("change", () => {
    paused = motion.matches;
    render();
    schedule();
  });
  document.addEventListener("visibilitychange", schedule);
  render();
  schedule();
}

// Opening the privacy link also expands the answer, including a direct deep link.
function openPrivacy() {
  if (location.hash === "#screen-safety")
    document.querySelector("#screen-safety")?.setAttribute("open", "");
}
window.addEventListener("hashchange", openPrivacy);
openPrivacy();
