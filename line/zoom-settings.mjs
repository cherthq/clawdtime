// Only preferences are durable. Presentation events, surfaces and media are not.
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const ZOOM_ACTIONS = ["enable", "disable", "overview", "resume"];
export function zoomIntent(text) {
  const said = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(/^(?:please |can you )/, "");
  if (
    /^(?:show (?:me )?(?:the )?(?:whole|full|entire) (?:screen|desktop)|zoom (?:all the way )?out)$/.test(
      said,
    )
  )
    return "overview";
  if (
    /^(?:resume (?:automatic|auto) zoom|(?:turn|switch) (?:automatic|auto) zoom back on)$/.test(
      said,
    )
  )
    return "resume";
  if (
    /^(?:(?:enable|disable) (?:automatic|auto) zoom|(?:turn|switch) (?:automatic|auto) zoom (?:on|off))$/.test(
      said,
    )
  )
    return /disable|off$/.test(said) ? "disable" : "enable";
  return null;
}

export function makeZoomSettings({ env = process.env, home = homedir() } = {}) {
  const root =
    env.CLAWDTIME_CONFIG_HOME || join(home, ".local/share/clawdtime");
  if (!isAbsolute(root))
    throw Error("Zoom settings require an absolute state path");
  const file = join(root, "line-presentation", "zoom.json");
  const defaults = {
    enabled: env.CLAWDTIME_LINE_AUTO_ZOOM !== "off",
    overview: false,
  };
  const safeDir = () => {
    const s = lstatSync(dirname(file));
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      s.mode & 0o077
    )
      throw Error("Private zoom settings directory required");
  };
  return {
    read() {
      let fd;
      try {
        safeDir();
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          stat.mode & 0o077 ||
          stat.size > 1024
        )
          throw Error("Invalid settings");
        const s = JSON.parse(readFileSync(fd, "utf8"));
        if (
          s.version !== 1 ||
          typeof s.enabled !== "boolean" ||
          typeof s.overview !== "boolean"
        )
          throw Error("Invalid settings");
        return {
          enabled: s.enabled,
          overview: s.overview,
          ...(typeof s.revision === "string" &&
          /^[a-f0-9-]{36}$/.test(s.revision) &&
          ZOOM_ACTIONS.includes(s.action)
            ? { revision: s.revision, action: s.action }
            : {}),
        };
      } catch (error) {
        // Missing is a new installation; corrupt/unreadable settings stay wide.
        return error.code === "ENOENT"
          ? { ...defaults }
          : { enabled: false, overview: true };
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    set(action) {
      if (!ZOOM_ACTIONS.includes(action)) throw Error("Unknown zoom control");
      const next = this.read();
      if (action === "enable") next.enabled = true;
      if (action === "disable") next.enabled = false;
      if (action === "overview") next.overview = true;
      if (action === "resume") {
        next.enabled = true;
        next.overview = false;
      }
      next.revision = randomUUID();
      next.action = action;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      safeDir();
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify({ version: 1, ...next }), {
          mode: 0o600,
          flag: "wx",
        });
        renameSync(temp, file);
      } finally {
        try {
          unlinkSync(temp);
        } catch {}
      }
      return next;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const settings = makeZoomSettings(),
    action = process.argv[2];
  if (action && action !== "status" && !ZOOM_ACTIONS.includes(action)) {
    console.error(
      "Usage: node line/zoom-settings.mjs status|enable|disable|overview|resume",
    );
    process.exitCode = 2;
  } else
    console.log(
      JSON.stringify(
        action && action !== "status" ? settings.set(action) : settings.read(),
      ),
    );
}
