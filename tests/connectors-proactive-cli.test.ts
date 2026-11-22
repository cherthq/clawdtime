import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proactiveCli } from "../cli/proactive.js";
import { secureWrite } from "../connectors/shared/state.js";
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-proactive-cli-"));
  roots.push(root);
  const file = join(root, "operator.json");
  secureWrite(file, { token: "operator-secret-fixture".repeat(3) });
  return {
    root,
    file,
    args: ["--origin", "http://127.0.0.1:13416", "--operator-file", file],
  };
}
it("reads doctor using protected token without printing it", async () => {
  const f = fixture();
  const said: string[] = [];
  let count = 0;
  await proactiveCli(["doctor", ...f.args], {
    print: (t) => said.push(t),
    request: async (url, options) => {
      count++;
      expect(String(url)).toBe(
        "http://127.0.0.1:13416/operator/proactive/doctor",
      );
      expect(options?.method).toBe("GET");
      return Response.json({ ready: false, reason: "retained_unknown" });
    },
  });
  expect(count).toBe(1);
  expect(said.join("")).toContain("retained_unknown");
  expect(said.join("")).not.toContain("operator-secret");
});
it("never retries a lost policy revocation response", async () => {
  const f = fixture();
  let count = 0;
  await expect(
    proactiveCli(["revoke", ...f.args, "--id", "policy"], {
      request: async () => {
        count++;
        throw Error("response lost");
      },
    }),
  ).rejects.toThrow("response lost");
  expect(count).toBe(1);
});
it("refuses remote origins before transmitting credentials", async () => {
  const f = fixture();
  let count = 0;
  await expect(
    proactiveCli(
      ["doctor", "--origin", "https://example.com", "--operator-file", f.file],
      {
        request: async () => {
          count++;
          return Response.json({});
        },
      },
    ),
  ).rejects.toThrow("loopback");
  expect(count).toBe(0);
});
