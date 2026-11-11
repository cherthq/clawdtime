let token,
  generation = 0;
const status = document.querySelector("#status");
function readInvite() {
  generation++;
  document.querySelector("#view").checked = false;
  document.querySelector("#control").checked = false;
  const params = new URLSearchParams(location.hash.slice(1));
  token = params.get("token");
  history.replaceState(null, "", "/pair");
  document.querySelector("#device").value = params.get("device") || "";
  document.querySelector("#display").value = params.get("display") || "";
  document.querySelector("#download").hidden = true;
  document.querySelector("#next").hidden = true;
  document.querySelector("button").disabled = !token;
  status.textContent = token
    ? ""
    : "Open the private pairing link sent to your verified Messages conversation.";
}
readInvite();
window.addEventListener("hashchange", readInvite);
document
  .querySelector("#pair-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const claimGeneration = generation;
    const button = document.querySelector("button");
    button.disabled = true;
    status.textContent = "Pairing…";
    try {
      const response = await fetch("/api/pairing/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          deviceId: document.querySelector("#device").value,
          displayId: document.querySelector("#display").value,
          allowView: document.querySelector("#view").checked,
          allowControl: document.querySelector("#control").checked,
        }),
      });
      const data = await response.json();
      if (claimGeneration !== generation) return;
      if (!response.ok) throw new Error(data.error || "Pairing failed.");
      const link = document.querySelector("#download");
      link.href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      link.download = "clawdtime-pairing.json";
      link.hidden = false;
      document.querySelector("#next").hidden = false;
      status.textContent =
        "Paired. Download your private file to finish local setup.";
    } catch (error) {
      if (claimGeneration !== generation) return;
      status.textContent = error.message;
      button.disabled = false;
    }
  });
