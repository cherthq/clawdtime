import { basename } from "node:path";
import type { ProcessFact } from "./processes.js";
import type { AgentKind } from "./types.js";

interface Signature {
  kind: AgentKind;
  label: string;
  /** Executable or launcher script names. */
  names: string[];
  /** Path fragment of the package when a runtime starts the script by path. */
  packagePath?: RegExp;
  /** A first argument that marks a helper, never a session. */
  helpers?: RegExp;
  /** An argument that marks a run with no person at the terminal. */
  headless?: RegExp;
}

/**
 * One row for each CLI. A new CLI is one new row. State evidence is separate:
 * a CLI with no evidence reader is still found, placed and focused, and its
 * state is honestly unknown.
 */
export const catalog: Signature[] = [
  {
    kind: "claude-code",
    label: "Claude Code",
    names: ["claude"],
    packagePath: /@anthropic-ai\/claude-code\//,
    helpers:
      /^(mcp|daemon|update|doctor|install|plugin|plugins|setup-token|config|auth|agents)$/,
    headless: /^(-p|--print)$/,
  },
  {
    kind: "codex",
    label: "Codex",
    names: ["codex"],
    packagePath: /@openai\/codex\//,
    helpers:
      /^(app-server|mcp-server|mcp|login|logout|completion|features|apply|cloud|sandbox|debug|proto)$/,
    headless: /^(exec|e|review)$/,
  },
  {
    kind: "pi",
    label: "pi",
    names: ["pi"],
    packagePath: /pi-coding-agent\//,
    headless: /^(-p|--print|--mode)$/,
  },
  {
    kind: "dexter",
    label: "dexter",
    names: ["dexter"],
    headless: /^(-p|--print|--mode)$/,
  },
  {
    kind: "amp",
    label: "Amp",
    names: ["amp"],
    packagePath: /@sourcegraph\/amp\//,
    helpers: /^(login|logout|update|mcp|permissions|tools|doctor)$/,
    headless: /^(-x|--execute)$/,
  },
  {
    kind: "gemini",
    label: "Gemini CLI",
    names: ["gemini"],
    packagePath: /@google\/gemini-cli\//,
    helpers: /^(mcp|extensions)$/,
    headless: /^(-p|--prompt)$/,
  },
  {
    kind: "opencode",
    label: "opencode",
    names: ["opencode"],
    helpers: /^(serve|upgrade|auth|models|web)$/,
    headless: /^run$/,
  },
  {
    kind: "aider",
    label: "aider",
    names: ["aider"],
    packagePath: /(^|\/)aider(\/|$)/,
    headless: /^(-m|--message|--message-file)$/,
  },
  {
    kind: "cursor-agent",
    label: "Cursor Agent",
    names: ["cursor-agent"],
    helpers: /^(login|logout|update|mcp|status)$/,
    headless: /^(-p|--print)$/,
  },
  {
    kind: "goose",
    label: "goose",
    names: ["goose"],
    helpers: /^(configure|info|update|mcp|web|schedule)$/,
    headless: /^run$/,
  },
  { kind: "crush", label: "Crush", names: ["crush"], headless: /^run$/ },
  {
    kind: "qwen",
    label: "Qwen Code",
    names: ["qwen"],
    packagePath: /@qwen-code\/qwen-code\//,
    headless: /^(-p|--prompt)$/,
  },
  {
    kind: "copilot",
    label: "Copilot CLI",
    names: ["copilot"],
    packagePath: /@github\/copilot\//,
    headless: /^(-p|--prompt)$/,
  },
  {
    kind: "droid",
    label: "Droid",
    names: ["droid"],
    helpers: /^(update|mcp)$/,
    headless: /^exec$/,
  },
];

const runtimes = /^(node|bun|deno|tsx|uv|python(\d(\.\d+)?)?)$/;
const scriptSuffix = /\.(mjs|cjs|js|ts|py)$/;

export const agentLabel = (kind: AgentKind) =>
  catalog.find((entry) => entry.kind === kind)?.label ?? kind;

export interface Identified {
  kind: AgentKind;
  label: string;
  /** No terminal, or started with a one-shot flag. */
  headless: boolean;
}

/**
 * Decides from the executable and arguments alone. A process with no terminal
 * counts only when its arguments mark a one-shot run, which keeps daemons,
 * language servers and helper children off the board.
 */
export function identify(process: ProcessFact): Identified | null {
  const tokens = process.command.split(/\s+/).filter(Boolean);
  const first = basename(process.exe).toLowerCase();
  let signature = catalog.find((entry) => entry.names.includes(first));
  let args = tokens.slice(1);
  if (!signature && runtimes.test(first)) {
    // A runtime started the CLI by path: node /…/bin/gemini, python -m aider.
    const index = tokens.findIndex(
      (token, position) => position > 0 && !token.startsWith("-"),
    );
    const script = index < 0 ? undefined : tokens[index];
    if (!script) return null;
    const name = basename(script).replace(scriptSuffix, "").toLowerCase();
    signature = catalog.find(
      (entry) =>
        entry.packagePath?.test(script) ||
        // A bare name counts only as a path, so "node pi" style noise is ignored.
        (script.includes("/") && entry.names.includes(name)),
    );
    args = tokens.slice(index + 1);
  }
  if (!signature) return null;
  const positional = args.find((token) => !token.startsWith("-"));
  if (positional && signature.helpers?.test(positional)) return null;
  const oneShot = args.some((token) => signature.headless?.test(token));
  if (!process.tty && !oneShot) return null;
  return {
    kind: signature.kind,
    label: signature.label,
    headless: !process.tty || oneShot,
  };
}
