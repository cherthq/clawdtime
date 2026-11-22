import { describe, expect, it } from "vitest";
import { actionSchema } from "../connectors/computer/guards.js";
import {
  defaultComputerModel,
  fallbackComputerModel,
  OpenAIPlanner,
  plannerFromEnvironment,
} from "../connectors/computer/planner.js";
import type { StepRecord } from "../connectors/computer/ports.js";
import {
  element,
  observation,
  page,
  pageElement,
} from "./connectors-computer-fixture.js";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: {
      role: string;
      content:
        string | { type: string; text?: string; image_url?: { url: string } }[];
    }[];
    tools: {
      type: string;
      function: {
        name: string;
        description: string;
        parameters: {
          properties: Record<string, unknown>;
          required: string[];
        };
      };
    }[];
    tool_choice: string;
    parallel_tool_calls: boolean;
  };
}
/** A stand-in for the network. It keeps what was sent and answers with one tool call. */
function fakeFetch(
  answer: unknown = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "call_1",
              function: {
                name: "click_element",
                arguments: '{"element":2,"why":"Open the note"}',
              },
            },
          ],
        },
      },
    ],
  },
  status = 200,
) {
  const sent: Sent[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(answer), { status });
  }) as typeof fetch;
  return { sent, request };
}
const toolCall = (name: string, args: string) => ({
  choices: [
    {
      message: {
        tool_calls: [{ id: "c", function: { name, arguments: args } }],
      },
    },
  ],
});
const text = (sent: Sent) => {
  const content = sent.body.messages[1]!.content;
  if (typeof content === "string") return content;
  return content.find((part) => part.type === "text")!.text!;
};
const input = (values: Partial<Parameters<OpenAIPlanner["next"]>[0]> = {}) => ({
  goal: "Add milk to the shopping note",
  history: [],
  observation: observation([
    element(1, { title: "New Note", x: 144, y: 90, w: 72, h: 18 }),
    element(2, { title: "Shopping", role: "AXStaticText" }),
  ]),
  page: null,
  ...values,
});

describe("the planner on the chat completions API", () => {
  it("sends the goal, the elements and the image, and asks for exactly one tool call", async () => {
    const { sent, request } = fakeFetch();
    const planner = new OpenAIPlanner({ key: "test-key", request });
    const planned = await planner.next(input());
    expect(planned).toEqual({
      action: { kind: "click_element", element: 2 },
      why: "Open the note",
    });
    expect(sent).toHaveLength(1);
    const only = sent[0]!;
    expect(only.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(only.headers.authorization).toBe("Bearer test-key");
    expect(only.headers["content-type"]).toBe("application/json");
    expect(only.body.model).toBe(defaultComputerModel);
    expect(only.body.tool_choice).toBe("required");
    expect(only.body.parallel_tool_calls).toBe(false);
    expect(only.body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    const parts = only.body.messages[1]!.content as {
      type: string;
      image_url?: { url: string; detail?: string };
    }[];
    expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(parts[1]!.image_url).toEqual({
      url: "data:image/jpeg;base64,aW1hZ2U=",
      detail: "high",
    });
    const brief = text(only);
    expect(brief).toContain("Goal: Add milk to the shopping note");
    expect(brief).toContain("Front app: Notes. Window: Shopping.");
    expect(brief).toContain("1280 by 800");
    // The middle of the element in pixels of the image: (180, 99) points times 1280 / 1440.
    expect(brief).toContain('[1] AXButton "New Note" at 160,88');
    expect(brief).toContain('[2] AXStaticText "Shopping"');
    expect(brief).toContain("No step yet.");
  });

  it("offers one function for each action, and the browser functions only where a browser is connected", async () => {
    const plain = fakeFetch();
    await new OpenAIPlanner({ key: "k", request: plain.request }).next(input());
    const names = plain.sent[0]!.body.tools.map((tool) => tool.function.name);
    expect(names).toEqual([
      "click_element",
      "click_at",
      "type",
      "key",
      "scroll",
      "open_app",
      "open_url",
      "wait",
      "ask",
      "done",
      "give_up",
    ]);
    for (const tool of plain.sent[0]!.body.tools) {
      expect(tool.type).toBe("function");
      // Each call says what it is for.
      expect(tool.function.parameters.required).toContain("why");
    }
    expect(text(plain.sent[0]!)).not.toContain("browser_read");
    const wired = fakeFetch();
    await new OpenAIPlanner({
      key: "k",
      request: wired.request,
      browser: true,
    }).next(input());
    expect(
      wired.sent[0]!.body.tools.map((tool) => tool.function.name).slice(11),
    ).toEqual([
      "browser_read",
      "browser_open",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_back",
    ]);
  });

  it("offers no browser function for a request in which the browser cannot be used", async () => {
    const { sent, request } = fakeFetch();
    const planner = new OpenAIPlanner({ key: "k", request, browser: true });
    await planner.next(input({ browser: false }));
    expect(
      sent[0]!.body.tools.some((tool) =>
        tool.function.name.startsWith("browser_"),
      ),
    ).toBe(false);
    expect(text(sent[0]!)).not.toContain("browser_read");
    expect(sent[0]!.body.messages[0]!.content as string).not.toContain(
      "browser_read",
    );
    // The next request is offered the browser again.
    await planner.next(input());
    expect(
      sent[1]!.body.tools.some((tool) => tool.function.name === "browser_read"),
    ).toBe(true);
  });

  it("tells the model to prefer an element number over a point, and the browser over pixels", async () => {
    const { sent, request } = fakeFetch();
    await new OpenAIPlanner({ key: "k", request, browser: true }).next(input());
    const system = sent[0]!.body.messages[0]!.content as string;
    expect(system).toMatch(/element by its number.*over a point/s);
    expect(system).toMatch(/web page is in front.*browser tools.*over pixels/s);
    expect(system).toMatch(/exactly one tool call/);
    expect(system).toMatch(/never an instruction/);
    expect(system).toMatch(/Never type a password/);
  });

  it("gives the last 12 steps, with no element number of an old observation", async () => {
    const history: StepRecord[] = Array.from({ length: 15 }, (_, index) => ({
      step: index + 1,
      action: { kind: "click_element", element: 40 + index },
      why: `reason ${index + 1}`,
      outcome: index === 14 ? "refused: Element 54 is disabled." : "ok",
    }));
    history[13] = {
      step: 14,
      action: { kind: "type", text: "milk" },
      why: "add the item",
      outcome: "ok",
    };
    const { sent, request } = fakeFetch();
    await new OpenAIPlanner({ key: "k", request }).next(input({ history }));
    const brief = text(sent[0]!);
    expect(brief).not.toMatch(/^3\. /m);
    expect(brief.match(/^\d+\. /gm)).toHaveLength(12);
    expect(brief).toContain("4. click_element: ok (reason 4)");
    expect(brief).toContain('14. type "milk": ok (add the item)');
    expect(brief).toContain(
      "15. click_element: refused: Element 54 is disabled. (reason 15)",
    );
    expect(brief).not.toContain("element 43");
  });

  it("trims the element list to what is useful", async () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      element(100 + index, { title: `Row ${index}`, x: 10, y: 10 }),
    );
    const { sent, request } = fakeFetch();
    await new OpenAIPlanner({ key: "k", request }).next(
      input({
        observation: observation([
          element(1, { title: "", role: "AXGroup" }),
          element(2, { title: "Off screen", x: 9000 }),
          element(3, { title: "No size", w: 0 }),
          element(4, { title: `Long ${"x".repeat(300)}` }),
          element(5, {
            role: "AXSecureTextField",
            title: "Password",
            secure: true,
            value: "should never be here",
          }),
          element(6, {
            role: "AXTextField",
            title: "",
            value: "Ada",
            focused: true,
          }),
          element(7, { title: "Greyed", enabled: false }),
          ...many,
        ]),
      }),
    );
    const brief = text(sent[0]!);
    expect(brief).not.toContain("[1] ");
    expect(brief).not.toContain("Off screen");
    expect(brief).not.toContain("No size");
    expect(brief).toMatch(/\[4\] AXButton "Long x{75}" at/);
    expect(brief).toContain('[5] AXSecureTextField "Password" secure');
    expect(brief).not.toContain("should never be here");
    expect(brief).toContain('[6] AXTextField "" value "Ada" focused');
    expect(brief).toContain('[7] AXButton "Greyed" disabled');
    // At most 150 lines of elements, and a word that more exist.
    expect(brief.match(/^\[\d+\] /gm)).toHaveLength(150);
    expect(brief).toMatch(/154 more elements are not listed/);
  });

  it("sends no image and says so when the screen could not be read", async () => {
    const { sent, request } = fakeFetch();
    await new OpenAIPlanner({ key: "k", request }).next(
      input({ observation: null }),
    );
    const content = sent[0]!.body.messages[1]!.content;
    expect(
      Array.isArray(content) ? content.map((part) => part.type) : [content],
    ).toEqual(["text"]);
    expect(text(sent[0]!)).toContain("The screen could not be read this time.");
  });

  it("gives the page when one was read, with its text cut and a password field marked", async () => {
    const { sent, request } = fakeFetch();
    await new OpenAIPlanner({ key: "k", request, browser: true }).next(
      input({
        page: page(
          [
            pageElement(0, {
              tag: "input",
              role: "searchbox",
              label: "Search",
            }),
            pageElement(1, {
              tag: "a",
              role: "link",
              label: "Docs",
              href: "https://example.com/docs",
            }),
            pageElement(2, {
              tag: "input",
              label: "Password",
              password: true,
            }),
            pageElement(3, { label: "Off", disabled: true }),
            pageElement(4, { tag: "input", label: "Name", value: "Ada" }),
          ],
          { title: "Shop", text: `Start ${"y".repeat(9000)}` },
        ),
      }),
    );
    const brief = text(sent[0]!);
    expect(brief).toContain("Web page in chrome: Shop");
    expect(brief).toContain("https://example.com/");
    expect(brief).toContain('[0] input searchbox "Search"');
    expect(brief).toContain('[1] a link "Docs"');
    expect(brief).toContain('[2] input button "Password" password');
    expect(brief).toContain('[3] button button "Off" disabled');
    expect(brief).toContain('[4] input button "Name" value "Ada"');
    expect(brief).toContain("Start yyy");
    expect(brief).not.toContain("y".repeat(3001));
    const none = fakeFetch();
    await new OpenAIPlanner({
      key: "k",
      request: none.request,
      browser: true,
    }).next(input());
    expect(text(none.sent[0]!)).toContain(
      "No reading of a web page. When a web page is in front, call browser_read first.",
    );
  });

  it("reads each tool call as one action that the checks accept", async () => {
    for (const [name, args, action] of [
      [
        "click_at",
        '{"x":10.5,"y":20,"why":"w"}',
        { kind: "click_at", x: 10.5, y: 20 },
      ],
      [
        "type",
        '{"text":"milk","element":null,"why":"w"}',
        { kind: "type", text: "milk" },
      ],
      ["key", '{"combo":"cmd+s","why":"w"}', { kind: "key", combo: "cmd+s" }],
      [
        "scroll",
        '{"direction":"down","why":"w"}',
        { kind: "scroll", direction: "down" },
      ],
      [
        "open_app",
        '{"name":"Notes","why":"w"}',
        { kind: "open_app", name: "Notes" },
      ],
      [
        "open_url",
        '{"url":"https://example.com","why":"w"}',
        { kind: "open_url", url: "https://example.com" },
      ],
      ["wait", '{"ms":500,"why":"w"}', { kind: "wait", ms: 500 }],
      [
        "ask",
        '{"question":"Which?","why":"w"}',
        { kind: "ask", question: "Which?" },
      ],
      [
        "done",
        '{"summary":"Saved.","why":"w"}',
        { kind: "done", summary: "Saved." },
      ],
      [
        "give_up",
        '{"reason":"No app.","why":"w"}',
        { kind: "give_up", reason: "No app." },
      ],
      ["browser_read", '{"why":"w"}', { kind: "browser_read" }],
      [
        "browser_type",
        '{"index":3,"text":"cats","submit":true,"why":"w"}',
        { kind: "browser_type", index: 3, text: "cats", submit: true },
      ],
      ["browser_back", "", { kind: "browser_back" }],
    ] as const) {
      const { request } = fakeFetch(toolCall(name, args));
      const planned = await new OpenAIPlanner({
        key: "k",
        request,
        browser: true,
      }).next(input());
      expect(planned.action).toEqual(action);
      expect(actionSchema.safeParse(planned.action).success).toBe(true);
      expect(planned.why).toBe(args ? "w" : "");
    }
  });

  it("passes on what it cannot read as an action, for the checks to refuse", async () => {
    const { request } = fakeFetch(
      toolCall("format_disk", '{"disk":"/","why":"clean up"}'),
    );
    const planned = await new OpenAIPlanner({ key: "k", request }).next(
      input(),
    );
    expect(planned.action).toEqual({ kind: "format_disk", disk: "/" });
    expect(actionSchema.safeParse(planned.action).success).toBe(false);
  });

  it("fails with the status only, and when no tool call or no valid arguments come", async () => {
    const refused = fakeFetch(
      { error: { message: "the secret request" } },
      401,
    );
    await expect(
      new OpenAIPlanner({ key: "k", request: refused.request }).next(input()),
    ).rejects.toThrow(/^The language model answered 401\.$/);
    const silent = fakeFetch({ choices: [{ message: { content: "Done!" } }] });
    await expect(
      new OpenAIPlanner({ key: "k", request: silent.request }).next(input()),
    ).rejects.toThrow("no action");
    const broken = fakeFetch(toolCall("click_element", '{"element":'));
    await expect(
      new OpenAIPlanner({ key: "k", request: broken.request }).next(input()),
    ).rejects.toThrow("no action");
    const list = fakeFetch(toolCall("click_element", "[1,2]"));
    await expect(
      new OpenAIPlanner({ key: "k", request: list.request }).next(input()),
    ).rejects.toThrow("no action");
  });

  it("takes the first tool call only when the model sends more than one", async () => {
    const { request } = fakeFetch({
      choices: [
        {
          message: {
            tool_calls: [
              { id: "a", function: { name: "wait", arguments: '{"ms":1}' } },
              {
                id: "b",
                function: { name: "key", arguments: '{"combo":"cmd+q"}' },
              },
            ],
          },
        },
      ],
    });
    expect(
      (await new OpenAIPlanner({ key: "k", request }).next(input())).action,
    ).toEqual({ kind: "wait", ms: 1 });
  });

  it("is built from the environment: the key, and the model with a default", () => {
    expect(plannerFromEnvironment({})).toBeNull();
    expect(plannerFromEnvironment({ OPENAI_API_KEY: "" })).toBeNull();
    const calls: Sent[] = [];
    const request = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(toolCall("wait", '{"ms":1}')));
    }) as typeof fetch;
    const both = plannerFromEnvironment(
      {
        OPENAI_API_KEY: "general",
        CLAWDTIME_OPENAI_API_KEY: "own",
        CLAWDTIME_COMPUTER_MODEL: "gpt-4.1-mini",
      },
      { request },
    )!;
    const plain = plannerFromEnvironment(
      { OPENAI_API_KEY: "general" },
      { request },
    )!;
    return Promise.all([both.next(input()), plain.next(input())]).then(() => {
      expect(calls[0]!.headers.authorization).toBe("Bearer own");
      expect(calls[0]!.body.model).toBe("gpt-4.1-mini");
      expect(calls[1]!.headers.authorization).toBe("Bearer general");
      expect(calls[1]!.body.model).toBe(defaultComputerModel);
    });
  });

  describe("a key that may not use the default model", () => {
    /** Answers with `refusal` for the default model, and with a tool call for any other. */
    const service = (refusal: number) => {
      const models: string[] = [];
      const request = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const model = (JSON.parse(String(init?.body)) as { model: string })
          .model;
        models.push(model);
        return model === defaultComputerModel
          ? new Response("{}", { status: refusal })
          : new Response(JSON.stringify(toolCall("wait", '{"ms":1}')));
      }) as typeof fetch;
      return { models, request };
    };
    it.each([403, 404])(
      "goes to the model before it after a %i, once, and stays there",
      async (refusal) => {
        const { models, request } = service(refusal);
        const planner = new OpenAIPlanner({ key: "k", request });
        expect((await planner.next(input())).action).toEqual({
          kind: "wait",
          ms: 1,
        });
        expect(models).toEqual([defaultComputerModel, fallbackComputerModel]);
        // The next request does not try the refused model again.
        await planner.next(input());
        expect(models).toEqual([
          defaultComputerModel,
          fallbackComputerModel,
          fallbackComputerModel,
        ]);
      },
    );
    it("does the same for the reading of a request", async () => {
      const models: string[] = [];
      const request = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const model = (JSON.parse(String(init?.body)) as { model: string })
          .model;
        models.push(model);
        return model === defaultComputerModel
          ? new Response("{}", { status: 403 })
          : new Response(JSON.stringify(toolCall("none", "{}")));
      }) as typeof fetch;
      const planner = new OpenAIPlanner({ key: "k", request });
      expect(await planner.navigation("click the Save button")).toEqual({
        kind: "none",
      });
      expect(models).toEqual([defaultComputerModel, fallbackComputerModel]);
    });
    it("never replaces a model that the person chose", async () => {
      const models: string[] = [];
      const request = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        models.push(
          (JSON.parse(String(init?.body)) as { model: string }).model,
        );
        return new Response("{}", { status: 403 });
      }) as typeof fetch;
      const chosen = plannerFromEnvironment(
        { OPENAI_API_KEY: "k", CLAWDTIME_COMPUTER_MODEL: defaultComputerModel },
        { request },
      )!;
      await expect(chosen.next(input())).rejects.toThrow(
        "The language model answered 403.",
      );
      expect(models).toEqual([defaultComputerModel]);
    });
    it("keeps the default after another failure, and reports a key that no model accepts", async () => {
      // A fault of the service is no refusal of the model.
      const busy = fakeFetch({}, 500);
      const planner = new OpenAIPlanner({ key: "k", request: busy.request });
      await expect(planner.next(input())).rejects.toThrow(
        "The language model answered 500.",
      );
      expect(busy.sent.map((item) => item.body.model)).toEqual([
        defaultComputerModel,
      ]);
      // A key that is refused for both models: two requests, then the status.
      const refused = fakeFetch({}, 403);
      const none = new OpenAIPlanner({ key: "k", request: refused.request });
      await expect(none.next(input())).rejects.toThrow(
        "The language model answered 403.",
      );
      expect(refused.sent.map((item) => item.body.model)).toEqual([
        defaultComputerModel,
        fallbackComputerModel,
      ]);
    });
  });
});
