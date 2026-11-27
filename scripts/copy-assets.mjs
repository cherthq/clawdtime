import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/public", { recursive: true });
cpSync("public", "dist/public", { recursive: true });
cpSync("release-source.json", "dist/release-source.json");
mkdirSync("dist/scripts", { recursive: true });
cpSync("scripts/install.sh", "dist/scripts/install.sh");
