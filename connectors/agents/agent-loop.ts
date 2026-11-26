/**
 * A general agent loop.
 *
 * The model gets the rules, the conversation and the tools. When it answers
 * with tool calls, they run and their results go back to it, and it is asked
 * again. The loop ends when the model answers in words with no call, when it
 * reaches its step limit, or at an abort (Stop).
 *
 * Rules that are code here:
 *
 * - Tools that only read run side by side when the model calls several in a
 *   row. A tool with an effect runs alone, in the order of the calls, and the
 *   next call waits for it.
 * - A gate runs before every call. It can refuse the call with a reason, and
 *   the model reads that reason as the result. The gate is where safety rules
 *   live in code.
 * - A hook runs after every call and can shorten its result. Every result is
 *   also cut to a fixed length.
 * - Messages that the owner sends while the loop runs are taken in at the next
 *   safe point: before each request of the model, which is between rounds of
 *   tools. They go in as new user messages.
 * - Before each request the conversation is fitted to a budget of characters.
 *   The rules and the live context always go; the newest turns go whole; the
 *   results of older tools are cut short; and the oldest messages are dropped
 *   when that is not enough. A tool result is never sent without the call
 *   that asked for it.
 * - An abort ends the loop at once: a waiting request of the model is left,
 *   tools that only read are left as they run, and no call after it starts.
 *   A tool with an effect gets the abort as its signal and ends first, so
 *   that no effect of it is left unknown.
 */

export interface LoopCall {
  id: string;
  name: string;
  /** JSON text, as the model sent it. Nothing in it is trusted. */
  arguments: string;
}

export type LoopMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; calls?: LoopCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export interface LoopToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The language model behind one call. Tests script it. */
export interface LoopModel {
  next(
    request: {
      system: string;
      messages: LoopMessage[];
      tools: LoopToolSpec[];
    },
    signal: AbortSignal,
  ): Promise<{ text: string; calls: LoopCall[] }>;
}

export interface LoopTool extends LoopToolSpec {
  /** True for a tool that changes something. False for one that only reads. */
  effect: boolean;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export type GateVerdict = { allow: true } | { allow: false; reason: string };

/** One call as the gate and the hook see it: the arguments already read. */
export interface CallSeen {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LoopEnd = "answer" | "limit" | "aborted";

export type LoopEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_start"; id: string; name: string; arguments: string }
  | { kind: "tool_end"; id: string; name: string; ok: boolean; result: string }
  | { kind: "refused"; id: string; name: string; reason: string }
  | { kind: "message"; text: string }
  | { kind: "trimmed"; dropped: number; shortened: number }
  | { kind: "end"; reason: LoopEnd; steps: number };

export interface LoopOptions {
  model: LoopModel;
  /** The rules. The same in every request. */
  system: string;
  /** The live state, made again before every request (the task graph view, notes). */
  context?: () => string;
  tools: LoopTool[];
  gate?: (call: CallSeen) => GateVerdict | Promise<GateVerdict>;
  /** Shortens a result after its call. It gets the result already cut to `resultLimit`. */
  after?: (call: CallSeen, result: string) => string;
  /** Messages of the owner that came while the loop ran. Each read takes them. */
  inbox?: () => string[];
  listener?: (event: LoopEvent) => void;
  signal?: AbortSignal;
  /** The most requests of the model with tools. One more, with none, says the words. */
  maxSteps?: number;
  /** The characters of the conversation that one request may carry. */
  budget?: number;
  /** How many of the newest turns of the owner go whole. */
  keepTurns?: number;
  /** The most characters of one tool result. */
  resultLimit?: number;
}

export interface LoopRecord {
  id: string;
  name: string;
  arguments: string;
  result: string;
  /** The gate's reason, when it refused the call. */
  refused?: string;
}

export interface LoopResult {
  /** The model's last words. Empty when it said none, as after an abort. */
  text: string;
  end: LoopEnd;
  /** The whole conversation after the run, nothing trimmed. */
  messages: LoopMessage[];
  /** Requests of the model that this run made. */
  steps: number;
  calls: LoopRecord[];
}

export const loopDefaults = {
  maxSteps: 8,
  budget: 24_000,
  keepTurns: 4,
  resultLimit: 4_000,
} as const;

/** What a result holds after its first characters when it is cut. */
const cutMark = " [cut]";
/** How much of an older tool result stays. */
const olderResultLength = 200;

const clip = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - cutMark.length))}${cutMark}`;

const sizeOf = (message: LoopMessage) =>
  message.content.length +
  (message.role === "assistant"
    ? (message.calls ?? []).reduce(
        (sum, call) => sum + call.name.length + call.arguments.length,
        0,
      )
    : message.role === "tool"
      ? message.name.length
      : 0);

/**
 * The conversation fitted to the budget. The newest `keepTurns` turns of the
 * owner go whole; older tool results are cut short; then the oldest units
 * (a user message, or an answer with the results of its calls) are dropped
 * until it fits. With too little room, fewer turns are kept whole, down to
 * one. A note at the start says how much was left out.
 */
export function fitConversation(
  messages: LoopMessage[],
  budget: number,
  keepTurns: number,
): { messages: LoopMessage[]; dropped: number; shortened: number } {
  for (let keep = Math.max(1, keepTurns); ; keep--) {
    const fitted = fitWith(messages, budget, keep);
    if (fitted.fits || keep <= 1) return fitted;
  }
}

function fitWith(messages: LoopMessage[], budget: number, keep: number) {
  // Where the newest `keep` turns of the owner begin.
  let start = messages.length;
  let turns = 0;
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]!.role === "user" && ++turns === keep) {
      start = index;
      break;
    }
  if (turns < keep) start = 0;
  let shortened = 0;
  const older = messages.slice(0, start).map((message): LoopMessage => {
    if (
      message.role !== "tool" ||
      message.content.length <= olderResultLength + cutMark.length
    )
      return message;
    shortened++;
    return { ...message, content: clip(message.content, olderResultLength) };
  });
  const recent = messages.slice(start);
  // The units of the older part: a tool result stays with the answer that called it.
  const units: LoopMessage[][] = [];
  for (const message of older) {
    if (message.role === "tool" && units.length) units.at(-1)!.push(message);
    else units.push([message]);
  }
  const total = (list: LoopMessage[]) =>
    list.reduce((sum, message) => sum + sizeOf(message), 0);
  let size = total(older) + total(recent);
  let dropped = 0;
  while (size > budget && units.length) {
    const unit = units.shift()!;
    size -= total(unit);
    dropped += unit.length;
  }
  // A result whose call was dropped is never sent alone.
  while (units[0]?.[0]?.role === "tool") dropped += units.shift()!.length;
  const kept = [...units.flat(), ...recent];
  // A result at the very start of the newest part has no call before it.
  while (kept[0]?.role === "tool") {
    kept.shift();
    dropped++;
  }
  const out =
    dropped > 0
      ? [
          {
            role: "user" as const,
            content: `[${dropped} earlier messages of this conversation were left out to fit.]`,
          },
          ...kept,
        ]
      : kept;
  return { messages: out, dropped, shortened, fits: size <= budget };
}

/** Reads the arguments of a call: a JSON object, or a reason why not. */
function readArguments(
  text: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.trim() || "{}");
  } catch {
    return { ok: false, reason: "The arguments are not JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, reason: "The arguments are not a JSON object." };
  return { ok: true, args: value as Record<string, unknown> };
}

/** Resolves with the work, or rejects at the abort, whichever comes first. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

export async function runAgentLoop(
  conversation: LoopMessage[],
  options: LoopOptions,
): Promise<LoopResult> {
  const signal = options.signal ?? new AbortController().signal;
  const maxSteps = options.maxSteps ?? loopDefaults.maxSteps;
  const budget = options.budget ?? loopDefaults.budget;
  const keepTurns = options.keepTurns ?? loopDefaults.keepTurns;
  const resultLimit = options.resultLimit ?? loopDefaults.resultLimit;
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const specs: LoopToolSpec[] = options.tools.map(
    ({ name, description, parameters }) => ({ name, description, parameters }),
  );
  const messages: LoopMessage[] = [...conversation];
  const calls: LoopRecord[] = [];
  let steps = 0;
  let text = "";
  const emit = (event: LoopEvent) => {
    try {
      options.listener?.(event);
    } catch {
      // A listener that fails changes nothing of the run.
    }
  };
  const takeInbox = () => {
    let taken: string[] = [];
    try {
      taken = options.inbox?.() ?? [];
    } catch {
      taken = [];
    }
    for (const said of taken) {
      if (!said.trim()) continue;
      messages.push({ role: "user", content: said });
      emit({ kind: "message", text: said });
    }
    return taken.length;
  };
  const finish = (end: LoopEnd): LoopResult => {
    emit({ kind: "end", reason: end, steps });
    return { text: end === "aborted" ? "" : text, end, messages, steps, calls };
  };
  const ask = async (offered: LoopToolSpec[]) => {
    const fitted = fitConversation(messages, budget, keepTurns);
    if (fitted.dropped || fitted.shortened)
      emit({
        kind: "trimmed",
        dropped: fitted.dropped,
        shortened: fitted.shortened,
      });
    const context = options.context?.() ?? "";
    steps++;
    return untilAbort(
      options.model.next(
        {
          system: context ? `${options.system}\n\n${context}` : options.system,
          messages: fitted.messages,
          tools: offered,
        },
        signal,
      ),
      signal,
    );
  };
  const runOne = async (call: LoopCall): Promise<string> => {
    const record: LoopRecord = {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      result: "",
    };
    calls.push(record);
    const tool = tools.get(call.name);
    const read = readArguments(call.arguments);
    let result: string;
    if (!tool) result = `Error: there is no tool named ${clip(call.name, 60)}.`;
    else if (!read.ok) result = `Error: ${read.reason}`;
    else if (signal.aborted) result = "Not run: the owner stopped this.";
    else {
      const seen: CallSeen = { id: call.id, name: call.name, args: read.args };
      let verdict: GateVerdict;
      try {
        verdict = (await options.gate?.(seen)) ?? { allow: true };
      } catch {
        verdict = { allow: false, reason: "The safety check failed." };
      }
      if (!verdict.allow) {
        record.refused = verdict.reason;
        emit({
          kind: "refused",
          id: call.id,
          name: call.name,
          reason: verdict.reason,
        });
        result = `Refused: ${verdict.reason}`;
      } else {
        emit({
          kind: "tool_start",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
        let ok = true;
        try {
          result = await tool.run(read.args, signal);
        } catch (error) {
          ok = false;
          result = `Error: ${error instanceof Error ? clip(error.message, 300) : "the tool failed."}`;
        }
        result = clip(result, resultLimit);
        try {
          result = options.after ? options.after(seen, result) : result;
        } catch {
          // A hook that fails keeps the result as it was.
        }
        emit({ kind: "tool_end", id: call.id, name: call.name, ok, result });
      }
    }
    record.result = result;
    return result;
  };

  for (;;) {
    if (signal.aborted) return finish("aborted");
    takeInbox();
    // At the step limit the model is asked once more, with no tools, for its words.
    const final = steps >= maxSteps;
    const offered = final ? [] : specs;
    let answer: { text: string; calls: LoopCall[] };
    try {
      answer = await ask(offered);
    } catch (error) {
      if (signal.aborted) return finish("aborted");
      throw error;
    }
    if (signal.aborted) return finish("aborted");
    // The ids of the calls: the model's own, made unique, so each result finds its call.
    const used = new Set<string>();
    const round = !final
      ? answer.calls.map((call, index) => {
          let id = call.id || `call_${steps}_${index}`;
          while (used.has(id)) id = `${id}_${index}`;
          used.add(id);
          return { ...call, id };
        })
      : [];
    text = answer.text.trim();
    if (!round.length) {
      // Words with no call: the answer, unless the owner said more meanwhile.
      messages.push({ role: "assistant", content: text });
      if (text) emit({ kind: "text", text });
      // At the limit too: the next request, still with no tools, answers them.
      if (takeInbox() > 0) continue;
      return finish(final ? "limit" : "answer");
    }
    messages.push({ role: "assistant", content: text, calls: round });
    if (text) emit({ kind: "text", text });
    // Reads in a row run side by side; a tool with an effect runs alone.
    for (let index = 0; index < round.length;) {
      const first = round[index]!;
      const isRead = (call: LoopCall) => tools.get(call.name)?.effect === false;
      if (!isRead(first)) {
        const content = await runOne(first);
        messages.push({
          role: "tool",
          callId: first.id,
          name: first.name,
          content,
        });
        index++;
        if (signal.aborted) return finish("aborted");
        continue;
      }
      let end = index;
      while (end < round.length && isRead(round[end]!)) end++;
      const batch = round.slice(index, end);
      let results: string[];
      try {
        // A read changes nothing: at the abort its answer is not waited for.
        results = await untilAbort(
          Promise.all(batch.map((call) => runOne(call))),
          signal,
        );
      } catch {
        return finish("aborted");
      }
      batch.forEach((call, at) =>
        messages.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          content: results[at]!,
        }),
      );
      index = end;
    }
  }
}
