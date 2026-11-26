/**
 * The model side of the two evals of computer use, with no model.
 *
 * The planner of the product talks to the language model through one
 * `fetch`. The evals replace that `fetch`, never the planner: a scripted
 * transport answers each call with one function call that a script chose,
 * and a fault layer in front of any transport (scripted or the real service)
 * answers chosen calls with a rate limit, an outage or a malformed answer.
 * Nothing here opens a connection.
 */

/** What the planner sent in one call: its functions with the names of their arguments, and the text it wrote. */
export interface PlannerAsk {
  tools: Map<string, string[]>;
  /** The text part of the last message: the goal, the steps, the elements. */
  brief: string;
}

interface Body {
  messages?: { content?: unknown }[];
  tools?: {
    function?: { name?: string; parameters?: { properties?: object } };
  }[];
}

export function readAsk(init: RequestInit | undefined): PlannerAsk {
  const body = JSON.parse(String(init?.body ?? "{}")) as Body;
  const tools = new Map<string, string[]>();
  for (const tool of body.tools ?? [])
    if (tool.function?.name)
      tools.set(
        tool.function.name,
        Object.keys(tool.function.parameters?.properties ?? {}),
      );
  // The brief is the last message of the person with parts; a repair adds a
  // plain message of words after it.
  const last = (
    [...(body.messages ?? [])]
      .reverse()
      .find((message) => Array.isArray(message.content)) ??
    body.messages?.at(-1)
  )?.content;
  const brief = Array.isArray(last)
    ? last
        .map((part: { type?: string; text?: string }) =>
          part.type === "text" ? (part.text ?? "") : "",
        )
        .join("\n")
    : typeof last === "string"
      ? last
      : "";
  return { tools, brief };
}

const json = (status: number, value: unknown, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** An answer of the service, in its form, with exactly one function call. */
export function toolAnswer(name: string, args: Record<string, unknown>) {
  return json(200, {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_scripted",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
}

/** One action that a script chose, in the loose form of a function call: the kind is the name. */
export type ScriptAction = { kind: string } & Record<string, unknown>;

/**
 * The outline of a scripted request: the subgoals that the request gives,
 * or one subgoal, the goal itself. The worker asks for an outline after its
 * first look (plan.ts). A long request gives 3 subgoals or more, so that it
 * may take as many actions as a long plan does.
 */
export function scriptedOutline(ask: PlannerAsk, subgoals?: string[]) {
  const goal = /^Goal: (.*)$/m.exec(ask.brief)?.[1]?.slice(0, 200) ?? "";
  return toolAnswer("outline", {
    subgoals: (subgoals?.length
      ? subgoals
      : [goal || "Do what the person asked."]
    ).map((part) => ({
      goal: part,
      check: "The screen shows that it is done.",
    })),
    why: "The scripted plan.",
  });
}

/**
 * A transport that answers each call with the action that `choose` gives.
 * The call for an outline, which offers only the outline function, gets
 * the scripted outline and uses no step. No network, no model.
 */
export function scriptedModel(
  choose: (ask: PlannerAsk) => Promise<ScriptAction> | ScriptAction,
  subgoals?: string[],
): typeof fetch {
  return async (_url, init) => {
    const ask = readAsk(init);
    if (ask.tools.has("outline")) return scriptedOutline(ask, subgoals);
    const { kind, ...args } = await choose(ask);
    return toolAnswer(kind, { ...args, why: "The scripted step." });
  };
}

/**
 * One fault of the model transport, for one call by its number (the first
 * call is 1, and every call counts, also one that the planner sends again).
 */
export type ModelFault =
  /** A rate limit with a retry-after header in seconds: a retry helps. */
  | { call: number; kind: "429"; retryAfterS?: number }
  /** The service is down for a moment. */
  | { call: number; kind: "503" }
  /** An answer with words and no function call. */
  | { call: number; kind: "no_tool_call" }
  /** A function call whose arguments are not JSON. */
  | { call: number; kind: "bad_json" };

/** Whether a request of the planner went to the Responses route of OpenAI: its turn is `input`, not `messages`. */
const responsesBody = (init: RequestInit | undefined) => {
  try {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
    return Array.isArray(body.input);
  } catch {
    return false;
  }
};

/** The malformed answers in the form of the Responses route. */
const responsesFault = (kind: "no_tool_call" | "bad_json") =>
  json(200, {
    status: "completed",
    output:
      kind === "no_tool_call"
        ? [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "I will click the button next." },
              ],
            },
          ]
        : [
            {
              type: "function_call",
              call_id: "call_broken",
              name: "click_element",
              arguments: '{"element": 3, "why": "open the',
            },
          ],
  });

const faultAnswer = (fault: ModelFault, responses: boolean): Response => {
  if (responses && (fault.kind === "no_tool_call" || fault.kind === "bad_json"))
    return responsesFault(fault.kind);
  switch (fault.kind) {
    case "429":
      return json(
        429,
        {
          error: {
            message: "Rate limit reached for requests. Try again soon.",
            type: "requests",
            code: "rate_limit_exceeded",
          },
        },
        { "retry-after": String(fault.retryAfterS ?? 1) },
      );
    case "503":
      return json(503, {
        error: {
          message: "The server is overloaded. Try again soon.",
          type: "server_error",
        },
      });
    case "no_tool_call":
      return json(200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will click the button next.",
            },
          },
        ],
      });
    case "bad_json":
      return json(200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_broken",
                  type: "function",
                  function: {
                    name: "click_element",
                    arguments: '{"element": 3, "why": "open the',
                  },
                },
              ],
            },
          },
        ],
      });
  }
};

/**
 * The transport `inner`, with faults on chosen calls. A faulted call never
 * reaches `inner`: no real call is spent on it and no scripted step is used.
 * Each fault that was given is written into `applied`, as "429 at call 1".
 */
export function withModelFaults(
  inner: typeof fetch,
  faults: ModelFault[],
  applied: string[],
): typeof fetch {
  let calls = 0;
  return async (url, init) => {
    calls += 1;
    const fault = faults.find((item) => item.call === calls);
    if (!fault) return inner(url, init);
    applied.push(`${fault.kind} at call ${calls}`);
    return faultAnswer(fault, responsesBody(init));
  };
}

/**
 * The network `inner`, with a request of the planner changed on its way out
 * as an eval asks: a reasoning effort of any word (`model@effort`) and the
 * small picture (`model:low`). Both routes of OpenAI are known:
 * `reasoning.effort` and `input_image` on Responses, `reasoning_effort` and
 * `image_url` on chat completions. Any other body goes out unchanged.
 */
export function withEvalRequest(
  inner: typeof fetch,
  change: { effort?: string | undefined; detail?: "low" | "high" },
): typeof fetch {
  if (!change.effort && change.detail !== "low") return inner;
  return async (url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      input?: { content?: unknown }[];
      messages?: { content?: unknown }[];
      reasoning?: Record<string, unknown>;
      reasoning_effort?: string;
    };
    const responses = Array.isArray(body.input);
    if (change.effort) {
      if (responses)
        body.reasoning = { ...body.reasoning, effort: change.effort };
      else body.reasoning_effort = change.effort;
    }
    if (change.detail === "low")
      for (const item of (responses ? body.input : body.messages) ?? [])
        if (Array.isArray(item.content))
          for (const part of item.content as {
            type?: string;
            detail?: string;
            image_url?: { detail?: string } | string;
          }[]) {
            if (part.type === "input_image") part.detail = "low";
            if (
              part.type === "image_url" &&
              part.image_url &&
              typeof part.image_url === "object"
            )
              part.image_url.detail = "low";
          }
    return inner(url, { ...init, body: JSON.stringify(body) });
  };
}

/** One element of the screen as the planner listed it for the model. */
export interface BriefElement {
  id: number;
  role: string;
  title: string;
  value?: string;
  focused: boolean;
  disabled: boolean;
  /** The middle, in pixels of the picture. */
  x?: number;
  y?: number;
}
/** One element of the web page as the planner listed it for the model. */
export interface BriefPageElement {
  index: number;
  tag: string;
  role: string;
  label: string;
  value?: string;
}

const screenLine =
  /^\[(\d+)\] (\S+) "([^"]*)"(?: value "([^"]*)")?( focused)?( disabled)?(?: secure)?(?: at (-?\d+),(-?\d+))?$/;
const pageLine =
  /^\[(\d+)\] (\S+) (\S+) "([^"]*)"(?: value "([^"]*)")?(?: password)?( disabled)?$/;

/** The elements of the screen and of the page, read back from the text that the planner wrote. */
export function readBrief(brief: string) {
  const screen: BriefElement[] = [];
  const page: BriefPageElement[] = [];
  let part: "none" | "screen" | "page" = "none";
  for (const row of brief.split("\n")) {
    if (row.startsWith("Elements of the screen")) part = "screen";
    else if (row.startsWith("Elements of the page")) part = "page";
    else if (row === "" || row.startsWith("Web page in")) part = "none";
    else if (part === "screen") {
      const m = screenLine.exec(row);
      if (m)
        screen.push({
          id: Number(m[1]),
          role: m[2]!,
          title: m[3]!,
          ...(m[4] !== undefined ? { value: m[4] } : {}),
          focused: m[5] !== undefined,
          disabled: m[6] !== undefined,
          ...(m[7] !== undefined ? { x: Number(m[7]), y: Number(m[8]) } : {}),
        });
    } else if (part === "page") {
      const m = pageLine.exec(row);
      if (m)
        page.push({
          index: Number(m[1]),
          tag: m[2]!,
          role: m[3]!,
          label: m[4]!,
          ...(m[5] !== undefined ? { value: m[5] } : {}),
        });
    }
  }
  return { screen, page };
}
