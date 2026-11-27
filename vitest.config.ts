import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Some test files of the line agent load the voice library itself, which is
// installed in line/node_modules and not in the root. Without it they cannot
// load, and a fresh clone that ran only `npm ci` would fail `npm test`. They
// run whenever the line is set up: `npm --prefix line install`.
const needVoiceLibrary = [
  "line/desktop-intent.test.mjs",
  "line/runtime-agent.test.mjs",
  "line/startup.test.mjs",
];
const voiceLibrary = existsSync(
  fileURLToPath(
    new URL(
      "./line/node_modules/@livekit/agents/package.json",
      import.meta.url,
    ),
  ),
);
if (!voiceLibrary)
  console.warn(
    `line/node_modules is not installed: ${needVoiceLibrary.join(", ")} do not run. Run: npm --prefix line install`,
  );

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Release builds stage a copy of the sources here; never test the copy.
      "artifacts/**",
      ...(voiceLibrary ? [] : needVoiceLibrary),
    ],
  },
});
