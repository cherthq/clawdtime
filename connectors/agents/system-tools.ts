/**
 * The chat tools of the process level: `system_look` reads it, and
 * `process_act` quits, force quits or restarts an app.
 *
 * A look only reads. Its words are data from this Mac, with every argument
 * and log line that looks like a credential already hidden. An action goes
 * through the ask policy in `connectors/system/act.ts`: a force quit asks
 * first, and only the owner's own clear yes in a newer message lets it go.
 * A yes that already answered another question in the same message counts
 * for nothing here: one message answers one question. A plain yes answers
 * the newest question that the owner saw: a force quit asked before a newer
 * question is asked again.
 */
import { realHost } from "../system/host.js";
import { ProcessDesk, processActions, type ProcessAsk } from "../system/act.js";
import { lookKinds, systemLook } from "../system/look.js";
import { SystemProbes } from "../system/probes.js";
import type { LoopTool } from "./agent-loop.js";
import type { ChatTurn } from "./chat-tools.js";

/** The process level of this Mac, with the owner's trust as the desktop service has it. */
export const realSystemDesk = (env: Record<string, string | undefined>) =>
  new ProcessDesk(new SystemProbes(realHost()), {
    trust: env.CLAWDTIME_COMPUTER_TRUST === "on",
  });

const text = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });

export function systemTools(
  desk: ProcessDesk,
  turn: ChatTurn,
  options: {
    computerBusy: () => boolean;
    /** False when the owner's newest words answer another question than this one. */
    mayDecide?: (ask: ProcessAsk) => boolean;
  },
): LoopTool[] {
  return [
    {
      name: "system_look",
      description:
        "Read the process level of this Mac, to debug it: why it is slow, what froze or crashed, what is on a port, what eats memory, whether a build or a server still runs. what: processes (the top by CPU, or by memory with sort memory, or those whose name holds name), process (one by name or pid: path, arguments, start, threads, open files, ports), ports (what listens, or what uses port), logs (the newest log lines of one process for the last minutes), crashes (the newest crash and hang reports, of name or of all), services (launchd jobs by label in name), memory (pressure, swap, load, disk, what holds the most). It only reads.",
      parameters: {
        type: "object",
        properties: {
          what: { type: "string", enum: [...lookKinds] },
          name: text("An app or a process name, or a part of a launchd label."),
          pid: number("A process id."),
          port: number("A TCP port."),
          sort: { type: "string", enum: ["cpu", "memory"] },
          minutes: number("For logs: the last minutes, 1 to 60."),
          days: number("For crashes: the last days, 1 to 30."),
        },
        required: ["what"],
        additionalProperties: false,
      },
      effect: false,
      run: (args) => systemLook(desk.probes, args),
    },
    {
      name: "process_act",
      description:
        "End or restart a process on this Mac, by its name or pid: quit asks an app to quit as Quit in the Dock does; force_quit ends a process at once; restart quits an app nicely and opens it again. Call it at once when the owner asks. A force quit, and a quit of a process that is no app, need the owner's yes: the result gives the question to say. After their yes, call it again with the same action and target.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...processActions] },
          name: text("The app or process name."),
          pid: number("The process id, when a name fits more than one."),
        },
        required: ["action"],
        additionalProperties: false,
      },
      effect: true,
      run: (args) =>
        desk.act(
          { action: args.action, pid: args.pid, name: args.name },
          {
            // A yes that answered another question in this message is spent.
            words: turn.answered ? "" : turn.owner,
            at: turn.ownerAt,
            ...(options.mayDecide ? { mayDecide: options.mayDecide } : {}),
            used: () => {
              turn.answered = true;
            },
          },
          { background: options.computerBusy() },
        ),
    },
  ];
}
