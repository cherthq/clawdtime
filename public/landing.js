document.documentElement.classList.add("js");

// Load the third-party player only after the visitor chooses to watch.
const videoButton = document.querySelector("#video-launch");
videoButton?.addEventListener(
  "click",
  () => {
    const frame = document.createElement("iframe");
    frame.src = "https://www.youtube-nocookie.com/embed/1DTf_1M67aw?autoplay=1";
    frame.title = "My AI agent FaceTimes me when it needs me | ClawdTime demo";
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    document.querySelector("#recorded-demo").replaceChildren(frame);
    frame.focus();
  },
  { once: true },
);

function openPrivacy() {
  if (location.hash === "#screen-safety")
    document.querySelector("#screen-safety")?.setAttribute("open", "");
}
window.addEventListener("hashchange", openPrivacy);
openPrivacy();

// Copy buttons: the install command and the coding agent prompt. The text
// comes from the element on the page, so what you see is what you paste.
const copyStatus = document.querySelector("#copy-status");
function copyWithSelection(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.className = "visually-hidden";
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}
document.querySelectorAll("[data-copy-target]").forEach((button) => {
  const source = document.getElementById(button.dataset.copyTarget);
  const label = button.querySelector("[data-copy-label]");
  if (!source || !label) return;
  const idle = label.textContent;
  let reset;
  button.addEventListener("click", async () => {
    const text = source.textContent.trim();
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = copyWithSelection(text);
      button.focus();
    }
    clearTimeout(reset);
    if (copied) {
      label.textContent = "Copied";
      button.dataset.state = "copied";
      if (copyStatus) copyStatus.textContent = "Copied to the clipboard.";
    } else {
      // No clipboard access: show and select the text so Command C copies it.
      source.closest("details")?.setAttribute("open", "");
      const range = document.createRange();
      range.selectNodeContents(source);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      label.textContent = "Press ⌘C";
      if (copyStatus)
        copyStatus.textContent = "Selected. Press Command C to copy.";
    }
    reset = setTimeout(() => {
      label.textContent = idle;
      delete button.dataset.state;
      if (copyStatus) copyStatus.textContent = "";
    }, 2000);
  });
});
