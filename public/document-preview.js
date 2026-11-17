/* View-only capability stays in the fragment and authorization header, never a query or cookie. */
(() => {
  const fragment = location.hash.slice(1),
    image = document.getElementById("image"),
    status = document.getElementById("status");
  history.replaceState(null, "", location.pathname);
  let objectURL;
  const clear = () => {
    image.removeAttribute("src");
    image.style.display = "none";
    if (objectURL) URL.revokeObjectURL(objectURL);
    status.textContent =
      "This private preview has expired. Ask ClawdTime to show it again.";
  };
  async function open() {
    const match = /^(preview_[a-f0-9]{40})\.([A-Za-z0-9_-]{43})$/.exec(
      fragment,
    );
    if (!match) return clear();
    const options = {
      headers: { Authorization: `Bearer ${match[2]}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    };
    const base = `/document-previews/${match[1]}`;
    const metaResponse = await fetch(`${base}/meta`, options);
    if (!metaResponse.ok) return clear();
    const meta = await metaResponse.json();
    if (
      typeof meta.name !== "string" ||
      !Number.isFinite(meta.expiresAt) ||
      meta.expiresAt <= Date.now()
    )
      return clear();
    const response = await fetch(`${base}/image`, options);
    if (!response.ok || response.headers.get("content-type") !== "image/png")
      return clear();
    const blob = await response.blob();
    if (blob.size > 2 * 1024 * 1024) return clear();
    objectURL = URL.createObjectURL(blob);
    image.src = objectURL;
    image.style.display = "block";
    document.getElementById("name").textContent = meta.name;
    status.textContent = "";
    setTimeout(
      clear,
      Math.min(120000, Math.max(0, meta.expiresAt - Date.now())),
    );
  }
  addEventListener("pagehide", clear, { once: true });
  open().catch(clear);
})();
