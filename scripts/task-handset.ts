import { readDesktopPrivateJSON } from "../src/control/task-desktop-config.js";
import {
  handsetConfigSchema,
  runHandsetAttempt,
} from "../src/control/task-handset-runtime.js";

let enteredRuntime = false;
async function main() {
  const path = process.argv[2]!;
  const config = handsetConfigSchema.parse(readDesktopPrivateJSON(path));
  enteredRuntime = true;
  await runHandsetAttempt(config, path);
}
main().catch(() => {
  if (!enteredRuntime)
    console.error(
      JSON.stringify({
        event: "setup_failed_before_call",
        cleanupConfirmed: true,
        ownerRetained: false,
      }),
    );
  process.exitCode = 1;
});
