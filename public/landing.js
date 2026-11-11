document.documentElement.classList.add("js");

const dialog = document.querySelector("#text-dialog");
if (dialog) {
  document.querySelectorAll("[data-text-it]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      dialog.showModal();
    });
  });
  dialog.querySelectorAll(".dialog-close, .dialog-done").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
}

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
      badge: "FAIL",
      caption: "Build stuck. Your phone rings.",
      eyebrow: "INCOMING FACETIME",
      subtitle: "A little help over here?",
      output: "× Timed out after 5000ms",
      detail: "One test. One quick question.",
      agent: "↗ Calling you for a second opinion…",
      mini: "× flaky.test.ts",
      speech: "“Skip that test.”",
    },
    {
      status: "YOU’RE CONNECTED",
      badge: "FAIL",
      caption: "See the screen. Say the fix.",
      eyebrow: "FACETIME · SCREEN SHARING",
      subtitle: "Your Mac, right here.",
      output: "× Timed out after 5000ms",
      detail: "Waiting for your direction…",
      agent: "→ You: “Skip that test.”",
      mini: "× flaky.test.ts",
      speech: "“Skip that test.”",
    },
    {
      status: "BACK TO WORK",
      badge: "SKIP",
      caption: "Unblocked. Back to your day.",
      eyebrow: "FACETIME · SCREEN SHARING",
      subtitle: "Got it. Carrying on.",
      output: "✓ Build passed · 1 test skipped",
      detail: "20 passed · 1 skipped",
      agent: "✓ Your agent is carrying on.",
      mini: "− flaky.test.ts skipped",
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
