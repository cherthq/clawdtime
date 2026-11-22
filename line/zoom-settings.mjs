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

/** The settings after one control. Each control gets its own revision. */
function controlled(settings, action) {
  if (!ZOOM_ACTIONS.includes(action)) throw Error("Unknown zoom control");
  const next = { ...settings };
  if (action === "enable") next.enabled = true;
  if (action === "disable") next.enabled = false;
  if (action === "overview") next.overview = true;
  if (action === "resume") {
    next.enabled = true;
    next.overview = false;
  }
  next.revision = randomUUID();
  next.action = action;
  return next;
}

/**
 * The zoom preferences. `durable` is true when they are kept in the file, for later calls too.
 * With a relative CLAWDTIME_CONFIG_HOME there is no fixed place for that file. A call must still start, so
 * the preferences then live in memory for as long as this store does, and nothing is read or written.
 */
export function makeZoomSettings({ env = process.env, home = homedir() } = {}) {
  const root =
    env.CLAWDTIME_CONFIG_HOME || join(home, ".local/share/clawdtime");
  const defaults = {
    enabled: env.CLAWDTIME_LINE_AUTO_ZOOM !== "off",
    overview: false,
  };
  if (!isAbsolute(root)) {
    let kept = { ...defaults };
    return {
      durable: false,
      read: () => ({ ...kept }),
      set(action) {
        kept = controlled(kept, action);
        return { ...kept };
      },
    };
  }
  const file = join(root, "line-presentation", "zoom.json");
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
    durable: true,
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
      const next = controlled(this.read(), action);
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
  } else if (!settings.durable) {
    // This command lives only to read or change the file. Without a file it must not report a success.
    console.error(
      "CLAWDTIME_CONFIG_HOME must be an absolute path. Nothing was read or saved.",
    );
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify(
        action && action !== "status" ? settings.set(action) : settings.read(),
      ),
    );
}
