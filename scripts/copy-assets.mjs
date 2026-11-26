import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/public", { recursive: true });
cpSync("public", "dist/public", { recursive: true });

mkdirSync("dist/media", { recursive: true });
for (const name of [
  "window-presentation.mjs",
  "driver-window-source.mjs",
  "background-window-video.mjs",
])
  cpSync(`media/${name}`, `dist/media/${name}`);
cpSync("release-source.json", "dist/release-source.json");
