import { countStates } from "../connectors/agents/board.js";
import type { Runner } from "../connectors/agents/focus.js";
import { stateRoot } from "../connectors/agents/hooks.js";
import { HostBook, remoteBoard } from "../connectors/agents/hosts.js";
import { summary } from "../connectors/agents/render.js";
import type { System } from "../connectors/agents/system.js";

export const hostsHelp = `clawdtime hosts: other Macs that this Mac supervises over ssh
  hosts add NAME SSH_TARGET [--command PATH]  NAME is yours. SSH_TARGET is a host alias or user@host
  hosts list
  hosts check NAME                            one call: does ssh answer, and what runs there
  hosts remove NAME
The other Mac needs the clawdtime command, and ssh to it must work with no password prompt.
Its sessions then show in: clawdtime agents (and --host NAME shows that Mac only).`;

export async function hostsCli(
  args: string[],
  deps: { system: System; runner: Runner; print: (line: string) => void },
) {
  const { system, runner, print } = deps;
  const book = new HostBook(stateRoot(system));
  const command = args[0] ?? "list";
  if (command === "help") return print(hostsHelp);
  if (command === "list") {
    const hosts = book.list();
    if (!hosts.length)
      return print(
        "No remote Mac. Add one: clawdtime hosts add NAME SSH_TARGET",
      );
    for (const host of hosts)
      print(
        `${host.name.padEnd(16)} ${host.ssh}${host.command === "clawdtime" ? "" : `  (${host.command})`}`,
      );
    return;
  }
  if (command === "add") {
    const rest = args.slice(1);
    const flag = rest.indexOf("--command");
    const path = flag < 0 ? undefined : rest[flag + 1];
    const positional =
      flag < 0 ? rest : rest.filter((_, i) => i < flag || i > flag + 1);
    if (positional.length !== 2 || (flag >= 0 && path === undefined))
      throw new Error(
        "Use: clawdtime hosts add NAME SSH_TARGET [--command PATH]",
      );
    const host = book.add({
      name: positional[0]!,
      ssh: positional[1]!,
      command: path,
      at: system.now(),
    });
    return print(
      `Added ${host.name} (${host.ssh}). Check it: clawdtime hosts check ${host.name}`,
    );
  }
  if (command === "remove" || command === "check") {
    const host = book.get(args[1]);
    if (!host || args.length !== 2)
      throw new Error(
        args[1]
          ? `No remote Mac is named "${args[1]}". See: clawdtime hosts list`
          : `Use: clawdtime hosts ${command} NAME`,
      );
    if (command === "remove") {
      book.remove(host.name);
      return print(`Removed ${host.name}. Nothing was changed on that Mac.`);
    }
    const board = await remoteBoard(host, runner);
    if (!board.ok) {
      process.exitCode = 2;
      return print(`${host.name} did not answer. ${board.message}`);
    }
    return print(
      `${host.name} answered over ssh: ${board.sessions.length === 1 ? "1 session" : `${board.sessions.length} sessions`}${board.sessions.length ? ` (${summary(countStates(board.sessions))})` : ""}.`,
    );
  }
  throw new Error("Use: clawdtime hosts add|list|check|remove");
}
