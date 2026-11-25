/**
 * One line about the process of the app in front, for the planner of
 * computer use, when its inputs change nothing on the screen: is the app at
 * full CPU, idle, stuck in a call to the system, or gone, with its newest
 * crash report. It runs a few short probes and no model. It never throws:
 * with no answer the planner gets no line.
 */
import { reportText } from "./look.js";
import { stateWord, type SystemProbes } from "./probes.js";

/** A report this new belongs to what the planner just saw. */
const recentMs = 10 * 60_000;

export async function frontAppFact(
  probes: SystemProbes,
  app: { name: string; bundleId: string },
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(app.bundleId)) return null;
  try {
    const lead = "Process fact (data from this Mac):";
    const pid = await probes.appPid(app.bundleId);
    const row = pid ? await probes.one(pid) : null;
    if (!row) {
      const name = app.name
        .replace(/[^\p{L}\p{N} ._+()&'-]/gu, "")
        .slice(0, 64);
      if (!name) return null;
      const { items } = await probes.reports({ name, days: 1, limit: 1 });
      const report = items[0];
      const now = probes.host.now();
      return `${lead} ${name} does not run now: it may have crashed or quit.${
        report && now - report.at <= recentMs
          ? ` ${reportText({ ...report, frames: [] }, now)}`
          : ""
      }`;
    }
    const name = row.isApp && row.app ? row.app : row.name;
    const cpu = Math.round(row.cpu);
    const busy = row.cpu >= 90;
    const stuck = /^[TUZ]/.test(row.state);
    return `${lead} ${name} (pid ${row.pid}) ${
      busy ? `is at full CPU (${cpu} percent)` : `uses ${cpu} percent CPU`
    } and is ${stateWord(row.state)} while the screen does not change: ${
      busy
        ? "it may be busy, or not responding."
        : stuck
          ? "it may not be responding."
          : "it may wait for something, or not respond."
    }`;
  } catch {
    return null;
  }
}
