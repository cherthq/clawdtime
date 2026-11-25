import { describe, expect, it } from "vitest";
import {
  backoffMs,
  defaultRetryPolicy,
  errorCode,
  retryAfterMs,
  statusTrouble,
} from "../connectors/computer/model-call.js";
import {
  defaultComputerModel,
  directOpening,
  fallbackComputerModel,
  OpenAIPlanner,
  PlannerError,
  type PlannerTrouble,
} from "../connectors/computer/planner.js";
import { element, observation } from "./connectors-computer-fixture.js";

const key = "sk-fixture-key-that-must-stay-hidden";
const goal = "Pay the fixture invoice 4471 for Ada";

interface Body {
  model: string;
  messages: {
    role: string;
    content: unknown;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[];
  tools: { function: { name: string } }[];
  tool_choice: string;
  parallel_tool_calls: boolean;
}
/** One answer of the scripted service. "hang" waits for the abort of its request. */
type Reply = (() => Response) | { throws: unknown } | "hang";

/** A scripted service: each request takes the next reply, and the last one repeats. */
function service(...replies: Reply[]) {
  const sent: { body: Body; signal: AbortSignal | undefined }[] = [];
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      body: JSON.parse(String(init?.body)) as Body,
      signal: init?.signal ?? undefined,
    });
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply === "hang")
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    if (typeof reply === "function") return reply();
    throw reply.throws;
  }) as typeof fetch;
  return { sent, request };
}
const answer =
  (body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { headers });
const failure =
  (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });
const call = (name: string, args: string, id = "call_1") => ({
  id,
  type: "function",
  function: { name, arguments: args },
});
const calls = (...items: ReturnType<typeof call>[]) => ({
  choices: [{ message: { content: null, tool_calls: items } }],
});
const waitCall = calls(call("wait", '{"ms":500,"why":"Let it load"}'));
const said = (content: string) => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
});
const networkError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`connect ${code}`), { code }),
  });

/** A clock that only moves when the planner waits, or when a test moves it. */
function clock(start = Date.parse("2026-11-25T10:00:00.000Z")) {
  let at = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
    // Each wait is half of its ceiling.
    random: () => 0.5,
    advance: (ms: number) => {
      at += ms;
    },
  };
}
type Clock = ReturnType<typeof clock>;

function planner(
  request: typeof fetch,
  time: Clock = clock(),
  options: Partial<ConstructorParameters<typeof OpenAIPlanner>[0]> = {},
) {
  return new OpenAIPlanner({
    key,
    api: "chat",
    request,
    now: time.now,
    sleep: time.sleep,
    random: time.random,
    ...options,
  });
}
const input = (values: Partial<Parameters<OpenAIPlanner["next"]>[0]> = {}) => ({
  goal,
  history: [],
  observation: observation([
    element(1, { title: "Pay", x: 144, y: 90, w: 72, h: 18 }),
  ]),
  page: null,
  ...values,
});
/** The error that a promise rejects with. */
async function failed(promise: Promise<unknown>): Promise<PlannerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlannerError);
    return error as PlannerError;
  }
  throw new Error("The call did not fail.");
}

describe("the planner through trouble of the language model", () => {
  it("asks again after a 429, and takes the next answer", async () => {
    const time = clock();
    const net = service(failure(429), answer(waitCall));
    const planned = await planner(net.request, time).next(input());
    expect(planned).toEqual({
      action: { kind: "wait", ms: 500 },
      why: "Let it load",
    });
    expect(net.sent).toHaveLength(2);
    // Full jitter: half of the first ceiling of 400 ms.
    expect(time.waits).toEqual([200]);
  });

  it("asks again after a 503 three times, with a doubling wait, and reports each retry", async () => {
    const time = clock();
    const seen: [number, PlannerTrouble, number | null][] = [];
    const net = service(
      failure(503),
      failure(503),
      failure(503),
      answer(waitCall),
    );
    const planned = await planner(net.request, time, {
      onAttempt: (attempt, trouble, delay) =>
        seen.push([attempt, trouble, delay]),
    }).next(input());
    expect(planned.action).toEqual({ kind: "wait", ms: 500 });
    expect(net.sent).toHaveLength(4);
    expect(time.waits).toEqual([200, 400, 800]);
    expect(seen).toEqual([
      [1, "transient", 200],
      [2, "transient", 400],
      [3, "transient", 800],
    ]);
    // The same request each time.
    expect(
      new Set(net.sent.map((item) => JSON.stringify(item.body))).size,
    ).toBe(1);
  });

  it("gives up after the last attempt with the status and the trouble", async () => {
    const time = clock();
    const net = service(failure(502));
    const error = await failed(planner(net.request, time).next(input()));
    expect(error.trouble).toBe("transient");
    expect(error.message).toBe("The language model answered 502.");
    expect(net.sent).toHaveLength(defaultRetryPolicy.attempts);
    expect(time.waits).toEqual([200, 400, 800]);
  });

  it.each([408, 409, 425, 500, 504])(
    "asks again after a %i",
    async (status) => {
      const net = service(failure(status), answer(waitCall));
      await planner(net.request).next(input());
      expect(net.sent).toHaveLength(2);
    },
  );

  it("waits as long as Retry-After says, in seconds, in milliseconds, or as a date", async () => {
    const seconds = clock();
    const one = service(
      failure(429, {}, { "retry-after": "2" }),
      answer(waitCall),
    );
    await planner(one.request, seconds).next(input());
    expect(seconds.waits).toEqual([2000]);

    const exact = clock();
    const two = service(
      failure(429, {}, { "retry-after-ms": "1500", "retry-after": "9" }),
      answer(waitCall),
    );
    await planner(two.request, exact).next(input());
    expect(exact.waits).toEqual([1500]);

    const dated = clock();
    const at = new Date(dated.now() + 3000).toUTCString();
    const three = service(
      failure(503, {}, { "retry-after": at }),
      answer(waitCall),
    );
    await planner(three.request, dated).next(input());
    expect(dated.waits).toEqual([3000]);
  });

  it("does not wait longer than its cap: a long Retry-After goes back to the caller", async () => {
    const time = clock();
    const net = service(failure(429, {}, { "retry-after": "120" }));
    const error = await failed(planner(net.request, time).next(input()));
    expect(error.trouble).toBe("transient");
    expect(error.retryAfterMs).toBe(120_000);
    expect(net.sent).toHaveLength(1);
    expect(time.waits).toEqual([]);
  });

  it.each(["insufficient_quota", "billing_hard_limit_reached"])(
    "does not ask again after a 429 with %s",
    async (code) => {
      const time = clock();
      const net = service(
        failure(429, { error: { code, message: `quota for ${goal}` } }),
      );
      const error = await failed(planner(net.request, time).next(input()));
      expect(error.trouble).toBe("quota");
      expect(error.message).toBe(`The language model answered 429 (${code}).`);
      expect(net.sent).toHaveLength(1);
      expect(time.waits).toEqual([]);
    },
  );

  it("does not ask again after a 401, or after a request that the service cannot take", async () => {
    const time = clock();
    const net = service(failure(401, { error: { code: "invalid_api_key" } }));
    const error = await failed(planner(net.request, time).next(input()));
    expect(error.trouble).toBe("auth");
    expect(error.message).toBe(
      "The language model answered 401 (invalid_api_key).",
    );
    expect(net.sent).toHaveLength(1);
    const bad = service(failure(400, { error: { type: "invalid_request" } }));
    const other = await failed(planner(bad.request, time).next(input()));
    expect(other.trouble).toBe("other");
    expect(bad.sent).toHaveLength(1);
    expect(time.waits).toEqual([]);
  });

  it("asks again after an error of the network, and names only its code", async () => {
    const time = clock();
    const net = service(
      { throws: networkError("ECONNRESET") },
      { throws: new TypeError("fetch failed") },
      answer(waitCall),
    );
    expect((await planner(net.request, time).next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(net.sent).toHaveLength(3);
    const down = service({ throws: networkError("UND_ERR_SOCKET") });
    const error = await failed(planner(down.request, clock()).next(input()));
    expect(error.trouble).toBe("transient");
    expect(error.message).toBe(
      "The language model could not be reached (UND_ERR_SOCKET).",
    );
  });

  it("does not ask again after an error that is no trouble of the network", async () => {
    const net = service({ throws: new RangeError("a bug") });
    const error = await failed(planner(net.request).next(input()));
    expect(error.trouble).toBe("other");
    expect(net.sent).toHaveLength(1);
  });

  it("ends one request at its own time, and asks again", async () => {
    // A real timer of 20 ms: the only way to show the timer of one request.
    const time = clock();
    const net = service("hang", answer(waitCall));
    const planned = await planner(net.request, time, { timeoutMs: 20 }).next(
      input(),
    );
    expect(planned.action).toEqual({ kind: "wait", ms: 500 });
    expect(net.sent).toHaveLength(2);
    expect(net.sent[0]!.signal!.aborted).toBe(true);
    // A timeout that the network reports is the same trouble.
    const timedOut = service({
      throws: new DOMException("The operation timed out.", "TimeoutError"),
    });
    const error = await failed(planner(timedOut.request).next(input()));
    expect(error.trouble).toBe("transient");
    expect(error.message).toBe("The language model did not answer in time.");
  });

  it("asks again after an answer that is not JSON", async () => {
    const net = service(
      () => new Response("<html>busy</html>"),
      answer(waitCall),
    );
    expect((await planner(net.request).next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(net.sent).toHaveLength(2);
  });

  it("stops asking when the budget of the call runs out", async () => {
    const time = clock();
    // Each answer takes 40 seconds and is a 503. The budget is 75 seconds.
    const slow = (async (...args: Parameters<typeof fetch>) => {
      time.advance(40_000);
      return net.request(...args);
    }) as typeof fetch;
    const net = service(failure(503));
    const error = await failed(planner(slow, time).next(input()));
    expect(error.trouble).toBe("transient");
    expect(net.sent).toHaveLength(2);
    expect(time.waits).toEqual([200]);
    expect(time.now() - Date.parse("2026-11-25T10:00:00.000Z")).toBeLessThan(
      defaultRetryPolicy.budgetMs + defaultRetryPolicy.attemptTimeoutMs,
    );
  });

  it("does not wait when the wait would end past the budget", async () => {
    const time = clock();
    const net = service(failure(503));
    const error = await failed(
      planner(net.request, time, { budgetMs: 3000 }).next(input()),
    );
    // A retry needs its wait and 2 seconds: 0 + 200 + 2000 and 200 + 400 +
    // 2000 fit in 3000 ms, 600 + 800 + 2000 does not.
    expect(time.waits).toEqual([200, 400]);
    expect(net.sent).toHaveLength(3);
    expect(error.retryAfterMs).toBe(800);
  });

  it("ends at once with the caller's reason when the caller aborts during a wait", async () => {
    const stop = new AbortController();
    const reason = new Error("The person said stop.");
    let waiting = () => {};
    const asleep = new Promise<void>((resolve) => (waiting = resolve));
    const net = service(failure(503), answer(waitCall));
    const plan = planner(net.request, clock(), {
      // A wait that never ends by itself.
      sleep: () => {
        waiting();
        return new Promise<void>(() => {});
      },
    }).next(input({ signal: stop.signal }));
    await asleep;
    stop.abort(reason);
    await expect(plan).rejects.toBe(reason);
    expect(net.sent).toHaveLength(1);
  });

  it("ends at once when the caller aborts during a request, and sends nothing after an abort", async () => {
    const stop = new AbortController();
    const net = service("hang");
    const plan = planner(net.request).next(input({ signal: stop.signal }));
    await Promise.resolve();
    stop.abort();
    await expect(plan).rejects.toMatchObject({ name: "AbortError" });
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]!.signal!.aborted).toBe(true);
    // A request that ignores its signal does not hold the caller either.
    const deaf = new AbortController();
    const ignoring = (() => new Promise<Response>(() => {})) as typeof fetch;
    const held = planner(ignoring).next(input({ signal: deaf.signal }));
    deaf.abort();
    await expect(held).rejects.toMatchObject({ name: "AbortError" });
    // Already aborted: no request goes out.
    const none = service(answer(waitCall));
    await expect(
      planner(none.request).next(input({ signal: AbortSignal.abort() })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(none.sent).toHaveLength(0);
  });

  it("asks again in the reading of a request too, and passes the caller's signal", async () => {
    const net = service(
      failure(503),
      answer(calls(call("desktop", '{"direction":"left"}'))),
    );
    const stop = new AbortController();
    expect(
      await planner(net.request).navigation(
        "move one desktop left",
        stop.signal,
      ),
    ).toEqual({ kind: "desktop", direction: "left" });
    expect(net.sent).toHaveLength(2);
    stop.abort();
    expect(net.sent[1]!.signal!.aborted).toBe(true);
    // The direct opening passes the signal on.
    const wrapped = directOpening(planner(service("hang").request));
    const halt = new AbortController();
    const reading = wrapped.navigation!("move one desktop left", halt.signal);
    halt.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails a reading that is not one clean call as malformed, with no second try", async () => {
    const net = service(answer(said("Sure, I moved left.")));
    const error = await failed(planner(net.request).navigation("go left"));
    expect(error.trouble).toBe("malformed");
    expect(error.message).toBe(
      "Navigation needs one structured interpretation.",
    );
    expect(net.sent).toHaveLength(1);
    const odd = service(
      answer(calls(call("desktop", `{"direction":"${goal}"}`))),
    );
    const quoted = await failed(planner(odd.request).navigation("go left"));
    expect(quoted.trouble).toBe("malformed");
    expect(quoted.message).toBe("Navigation interpretation is invalid.");
  });
});

describe("the repair of an answer that cannot be used", () => {
  /** The messages that the repair added to the first request. */
  const added = (net: ReturnType<typeof service>) =>
    net.sent[1]!.body.messages.slice(net.sent[0]!.body.messages.length);

  it("asks once more after an answer with no tool call", async () => {
    const net = service(answer(said("I will click Pay.")), answer(waitCall));
    const planned = await planner(net.request).next(input());
    expect(planned.action).toEqual({ kind: "wait", ms: 500 });
    expect(net.sent).toHaveLength(2);
    const [first, second] = [net.sent[0]!.body, net.sent[1]!.body];
    // The same request: the same rules, picture, functions and choice.
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(second.tools).toEqual(first.tools);
    expect(second.tool_choice).toBe("required");
    expect(second.parallel_tool_calls).toBe(false);
    expect(added(net)).toEqual([
      { role: "assistant", content: "I will click Pay." },
      {
        role: "user",
        content:
          "The program could not use your last answer. It had no tool call. Nothing was run. Call exactly one of the offered functions, with its arguments as one JSON object.",
      },
    ]);
  });

  it("asks once more after arguments that are not JSON, and answers the tool call", async () => {
    const net = service(
      answer(calls(call("click_element", '{"element":', "call_9"))),
      answer(calls(call("click_element", '{"element":1,"why":"Pay"}'))),
    );
    const planned = await planner(net.request).next(input());
    expect(planned).toEqual({
      action: { kind: "click_element", element: 1 },
      why: "Pay",
    });
    expect(added(net)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_9",
            type: "function",
            function: { name: "click_element", arguments: '{"element":' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_9", content: "Not run." },
      {
        role: "user",
        content: expect.stringContaining(
          "The arguments of click_element are not valid JSON. Nothing was run. Call exactly one of the offered functions",
        ),
      },
    ]);
  });

  it("asks once more after a function that was not offered", async () => {
    const net = service(
      answer(calls(call("browser_read", '{"why":"read"}'))),
      answer(waitCall),
    );
    // No browser is connected, so browser_read was not offered.
    const planned = await planner(net.request).next(input());
    expect(planned.action).toEqual({ kind: "wait", ms: 500 });
    expect(added(net).at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining(
        '"browser_read" is not one of the offered functions.',
      ),
    });
  });

  it("asks once more after arguments that do not fit the action", async () => {
    const net = service(
      answer(calls(call("click_element", '{"element":"Pay","why":"w"}'))),
      answer(waitCall),
    );
    expect((await planner(net.request).next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(added(net).at(-1)!.content).toMatch(
      /^The program could not use your last answer\. The arguments of click_element do not fit its parameters: element: .+\. Nothing was run\./,
    );
  });

  it("asks once more after two tool calls, and runs none of them", async () => {
    const net = service(
      answer(
        calls(
          call("wait", '{"ms":1,"why":"a"}', "a"),
          call("key", '{"combo":"cmd+q","why":"b"}', "b"),
        ),
      ),
      answer(waitCall),
    );
    expect((await planner(net.request).next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    const tail = added(net);
    expect(tail.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "a", content: "Not run." },
      { role: "tool", tool_call_id: "b", content: "Not run." },
    ]);
    expect(tail.at(-1)!.content).toContain(
      "It had 2 tool calls, and only one is taken, so none of them ran.",
    );
  });

  it("fails as malformed after a second answer that cannot be used", async () => {
    const seen: [number, PlannerTrouble, number | null][] = [];
    const net = service(
      answer(said("Done!")),
      answer(calls(call("click_element", "[1,2]"))),
    );
    const error = await failed(
      planner(net.request, clock(), {
        onAttempt: (attempt, trouble, delay) =>
          seen.push([attempt, trouble, delay]),
      }).next(input()),
    );
    expect(error.trouble).toBe("malformed");
    expect(error.message).toBe(
      "The planner chose no action that can be read (not_an_object).",
    );
    expect(net.sent).toHaveLength(2);
    expect(seen).toEqual([
      [1, "malformed", 0],
      [2, "malformed", null],
    ]);
  });

  it("does not repair a refusal", async () => {
    for (const refused of [
      {
        choices: [
          {
            message: { content: null, refusal: "I can't help with that." },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [
          { message: { content: "" }, finish_reason: "content_filter" },
        ],
      },
    ]) {
      const net = service(answer(refused), answer(waitCall));
      const error = await failed(planner(net.request).next(input()));
      expect(error.trouble).toBe("refused");
      expect(net.sent).toHaveLength(1);
    }
    // A refusal of the reading of a request is a refusal too.
    const reading = service(
      answer({ choices: [{ message: { refusal: "No." } }] }),
    );
    expect(
      (await failed(planner(reading.request).navigation("go left"))).trouble,
    ).toBe("refused");
  });

  it("asks the repair again after transient trouble, inside the same budget", async () => {
    const time = clock();
    const net = service(answer(said("Hmm.")), failure(503), answer(waitCall));
    expect((await planner(net.request, time).next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(net.sent).toHaveLength(3);
    expect(time.waits).toEqual([200]);
  });

  it("makes no repair when the budget has no time left for it", async () => {
    const time = clock();
    const late = (async (...args: Parameters<typeof fetch>) => {
      time.advance(74_000);
      return net.request(...args);
    }) as typeof fetch;
    const net = service(answer(said("Hmm.")), answer(waitCall));
    const error = await failed(planner(late, time).next(input()));
    expect(error.trouble).toBe("malformed");
    expect(net.sent).toHaveLength(1);
  });
});

describe("the breaker of one planner", () => {
  it("opens after transient failures in a row, fails at once, lets one probe through, and closes", async () => {
    const time = clock();
    let down = true;
    const sent: number[] = [];
    const request = (async () => {
      sent.push(time.now());
      return down
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify(waitCall));
    }) as typeof fetch;
    const model = planner(request, time);
    const { attempts, breakerThreshold, breakerCooldownMs } =
      defaultRetryPolicy;
    // The first call uses all its attempts and stays below the threshold.
    expect((await failed(model.next(input()))).retryAfterMs).toBeUndefined();
    expect(sent).toHaveLength(attempts);
    // The second call reaches it, and the breaker opens.
    const opened = await failed(model.next(input()));
    expect(sent).toHaveLength(breakerThreshold);
    expect(opened.trouble).toBe("transient");
    expect(opened.retryAfterMs).toBe(breakerCooldownMs);
    // Open: every call fails at once, with no request, for the cool-down.
    time.advance(10_000);
    const fast = await failed(model.next(input()));
    expect(fast.trouble).toBe("transient");
    expect(fast.retryAfterMs).toBe(breakerCooldownMs - 10_000);
    expect((await failed(model.navigation("go left"))).trouble).toBe(
      "transient",
    );
    expect(sent).toHaveLength(breakerThreshold);
    // After the cool-down one probe goes out. It fails, and the breaker opens again.
    time.advance(breakerCooldownMs);
    const probe = await failed(model.next(input()));
    expect(sent).toHaveLength(breakerThreshold + 1);
    expect(probe.retryAfterMs).toBe(breakerCooldownMs);
    await failed(model.next(input()));
    expect(sent).toHaveLength(breakerThreshold + 1);
    // The service is back: the next probe passes and closes the breaker.
    time.advance(breakerCooldownMs);
    down = false;
    expect((await model.next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(sent).toHaveLength(breakerThreshold + 2);
    // Closed: one more failure is asked again as usual.
    down = true;
    const again = model.next(input());
    const settled = await failed(again);
    expect(settled.message).toBe("The language model answered 503.");
    expect(sent).toHaveLength(breakerThreshold + 2 + attempts);
  });

  it("counts only transient trouble: an answer of the service resets the count", async () => {
    const time = clock();
    const net = service(
      failure(503),
      failure(503),
      failure(503),
      failure(503),
      failure(400),
      failure(503),
      failure(503),
      failure(503),
      failure(503),
      answer(waitCall),
    );
    const model = planner(net.request, time);
    await failed(model.next(input()));
    expect((await failed(model.next(input()))).trouble).toBe("other");
    // Four more failures stay below the threshold: no breaker opened.
    expect((await failed(model.next(input()))).message).toBe(
      "The language model answered 503.",
    );
    expect((await model.next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(net.sent).toHaveLength(10);
  });

  it("is one for each planner", async () => {
    const time = clock();
    const net = service(failure(503));
    const first = planner(net.request, time);
    await failed(first.next(input()));
    await failed(first.next(input()));
    const fresh = service(answer(waitCall));
    expect((await planner(fresh.request, time).next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
  });

  it("lets the next call probe when the caller aborted the probe", async () => {
    const time = clock();
    let mode: "down" | "hang" | "up" = "down";
    let started = () => {};
    const sent: string[] = [];
    const request = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      sent.push(mode);
      if (mode === "up") return new Response(JSON.stringify(waitCall));
      if (mode === "down") return new Response("{}", { status: 503 });
      started();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () =>
          reject(init!.signal!.reason),
        ),
      );
    }) as typeof fetch;
    const model = planner(request, time);
    await failed(model.next(input()));
    await failed(model.next(input()));
    time.advance(defaultRetryPolicy.breakerCooldownMs);
    mode = "hang";
    const stop = new AbortController();
    const probing = new Promise<void>((resolve) => (started = resolve));
    const plan = model.next(input({ signal: stop.signal }));
    await probing;
    stop.abort();
    await expect(plan).rejects.toMatchObject({ name: "AbortError" });
    // The aborted probe holds nothing: the next call is the probe.
    mode = "up";
    expect((await model.next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(sent.slice(-2)).toEqual(["hang", "up"]);
  });
});

describe("what an error of the planner holds", () => {
  it("holds no key, no goal and no body, whatever the service sends back", async () => {
    const echo = { error: { message: `${goal} with ${key}`, param: goal } };
    const cases: Reply[][] = [
      [failure(400, echo)],
      [failure(401, echo)],
      [failure(403, echo)],
      [failure(404, echo)],
      [failure(429, { error: { code: "insufficient_quota", message: goal } })],
      [failure(500, echo)],
      [failure(429, { error: { code: goal, type: key } })],
      [{ throws: new TypeError(`fetch failed for ${goal} ${key}`) }],
      [{ throws: Object.assign(new Error(goal), { code: key }) }],
      [() => new Response(`${goal} ${key}`)],
      [answer(said(`${goal} ${key}`))],
      [answer(calls(call(`${goal} ${key}`, "{}")))],
      [answer(calls(call("type", `{"text":"${goal}"`)))],
      [
        answer({
          choices: [{ message: { refusal: `${goal} ${key}` } }],
        }),
      ],
    ];
    for (const replies of cases) {
      for (const run of [
        (model: OpenAIPlanner) => model.next(input()),
        (model: OpenAIPlanner) => model.navigation(goal),
      ]) {
        const net = service(...replies);
        const error = await failed(run(planner(net.request)));
        for (const text of [
          error.message,
          String(error),
          JSON.stringify(error),
          String(error.cause ?? ""),
        ]) {
          expect(text).not.toContain(key);
          expect(text).not.toContain("4471");
          expect(text).not.toContain("invoice");
        }
      }
    }
  });
});

describe("the model fallback with retries", () => {
  it("goes to the model before it after a 403 once, retries there, and stays there", async () => {
    const time = clock();
    const net = service(failure(403), failure(503), answer(waitCall));
    const model = planner(net.request, time);
    expect((await model.next(input())).action).toEqual({
      kind: "wait",
      ms: 500,
    });
    expect(net.sent.map((item) => item.body.model)).toEqual([
      defaultComputerModel,
      fallbackComputerModel,
      fallbackComputerModel,
    ]);
    // The switch is no retry: only the 503 waited.
    expect(time.waits).toEqual([200]);
    await model.next(input());
    expect(net.sent.at(-1)!.body.model).toBe(fallbackComputerModel);
  });

  it("keeps a chosen model, and a 403 for it is auth with no retry", async () => {
    const net = service(failure(403));
    const error = await failed(
      planner(net.request, clock(), { model: "gpt-4.1-mini" }).next(input()),
    );
    expect(error.trouble).toBe("auth");
    expect(net.sent.map((item) => item.body.model)).toEqual(["gpt-4.1-mini"]);
  });

  it("reports a model that the service does not know, for both models, as other", async () => {
    const net = service(failure(404));
    const error = await failed(planner(net.request).next(input()));
    expect(error.trouble).toBe("other");
    expect(net.sent.map((item) => item.body.model)).toEqual([
      defaultComputerModel,
      fallbackComputerModel,
    ]);
  });
});

describe("the parts of one call", () => {
  it("reads statuses", () => {
    expect(statusTrouble(429, null)).toBe("transient");
    expect(statusTrouble(429, "rate_limit_exceeded")).toBe("transient");
    expect(statusTrouble(429, "insufficient_quota")).toBe("quota");
    expect(statusTrouble(429, "billing_not_active")).toBe("quota");
    expect(statusTrouble(402, null)).toBe("quota");
    expect(statusTrouble(401, null)).toBe("auth");
    expect(statusTrouble(403, null)).toBe("auth");
    expect(statusTrouble(404, null)).toBe("other");
    expect(statusTrouble(400, null)).toBe("other");
    expect(statusTrouble(501, null)).toBe("other");
  });

  it("reads only a plain error code from a body", () => {
    expect(errorCode('{"error":{"code":"insufficient_quota"}}')).toBe(
      "insufficient_quota",
    );
    expect(errorCode('{"error":{"code":null,"type":"server_error"}}')).toBe(
      "server_error",
    );
    expect(errorCode('{"error":{"code":"has spaces in it"}}')).toBeNull();
    // Only a lowercase word with underscores: nothing shaped like a key.
    expect(errorCode('{"error":{"code":"sk-proj-Abc123"}}')).toBeNull();
    expect(errorCode("not json")).toBeNull();
    expect(errorCode('{"error":"text"}')).toBeNull();
  });

  it("reads Retry-After", () => {
    const now = Date.parse("2026-11-25T10:00:00.000Z");
    const headers = (values: Record<string, string>) => new Headers(values);
    expect(retryAfterMs(headers({}), now)).toBeUndefined();
    expect(retryAfterMs(headers({ "retry-after": "1.5" }), now)).toBe(1500);
    expect(retryAfterMs(headers({ "retry-after-ms": "250" }), now)).toBe(250);
    expect(
      retryAfterMs(
        headers({ "retry-after": new Date(now + 5000).toUTCString() }),
        now,
      ),
    ).toBe(5000);
    expect(
      retryAfterMs(
        headers({ "retry-after": new Date(now - 5000).toUTCString() }),
        now,
      ),
    ).toBe(0);
    expect(
      retryAfterMs(headers({ "retry-after": "soon" }), now),
    ).toBeUndefined();
  });

  it("waits with full jitter on a doubling, up to the cap", () => {
    const policy = defaultRetryPolicy;
    expect(backoffMs(1, policy, () => 0.999)).toBe(399);
    expect(backoffMs(3, policy, () => 0.5)).toBe(800);
    expect(backoffMs(20, policy, () => 0.5)).toBe(4000);
    expect(backoffMs(2, policy, () => 0)).toBe(0);
  });

  it("goes on when the report of an attempt throws", async () => {
    const net = service(failure(503), answer(waitCall));
    const planned = await planner(net.request, clock(), {
      onAttempt: () => {
        throw new Error("no record");
      },
    }).next(input());
    expect(planned.action).toEqual({ kind: "wait", ms: 500 });
  });
});
