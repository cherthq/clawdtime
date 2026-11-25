import { homedir } from "node:os";
import { stateRoot } from "../connectors/agents/hooks.js";
import { Routines } from "../connectors/computer/routines.js";

export const routineHelp = `clawdtime routine: a request that the computer worker gets at a time of day
  routine add WORDS      for example: routine add every morning at 9, follow up on my latest posts
  routine list           every routine, its time and when it runs next
  routine pause ID       it does not run until you resume it
  routine resume ID      it runs again from its next time
  routine remove ID      it is gone. A request that it started goes on
A routine runs only when no other request runs and no call is live. It texts
you the result. The desktop service runs the routines: start it with the
computer worker on. See docs/COMPUTER_USE.md.`;
const usage = "Use: clawdtime routine add|list|pause|resume|remove";

/** The routines of this Mac, in the file that the desktop service reads. Nothing here runs a request. */
export async function routineCli(
  args: string[],
  dependencies: {
    env?: Record<string, string | undefined>;
    home?: string;
    now?: () => number;
    print?: (line: string) => void;
  } = {},
) {
  const env = dependencies.env ?? process.env;
  const print = dependencies.print ?? console.log;
  const root = stateRoot({ env, home: dependencies.home ?? homedir() });
  const routines = new Routines({
    root,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const command = args[0] ?? "list";
  if (command === "help" || command === "--help") return print(routineHelp);
  if (command === "add") {
    const words = args.slice(1).join(" ").trim();
    if (!words)
      throw new Error(`${usage}. Add needs the words of the routine.`);
    const added = routines.add(words);
    if (!added.ok) throw new Error(added.message);
    return print(added.message);
  }
  if (command === "list") {
    if (args.length > 1) throw new Error(usage);
    const all = routines.list();
    if (!all.length)
      return print(
        "No routine yet. Add one: clawdtime routine add every morning at 9, follow up on my latest posts",
      );
    for (const routine of all) print(routines.line(routine));
    return;
  }
  if (["pause", "resume", "remove"].includes(command)) {
    const id = args[1]?.trim().toLowerCase() ?? "";
    if (args.length !== 2 || !/^[a-f0-9]{8}$/.test(id))
      throw new Error(`${usage}. ${command} needs the id from: routine list`);
    const routine =
      command === "pause"
        ? routines.pause(id)
        : command === "resume"
          ? routines.resume(id)
          : routines.remove(id);
    if (!routine) throw new Error(`There is no routine ${id}.`);
    return print(
      command === "pause"
        ? `Paused routine ${id}. A request that it started goes on.`
        : command === "resume"
          ? `Routine ${id} runs again.`
          : `Removed routine ${id}. A request that it started goes on.`,
    );
  }
  throw new Error(usage);
}
