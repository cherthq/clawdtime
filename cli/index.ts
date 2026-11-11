import { main } from "./main.js";
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "ClawdTime failed.");
  process.exitCode = 1;
});
