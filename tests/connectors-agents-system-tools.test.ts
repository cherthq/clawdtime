import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../connectors/agents/brain.js";
import { ChatAgent, chatAgentRules } from "../connectors/agents/chat-agent.js";
import { effectTools } from "../connectors/agents/chat-tools.js";
import { ProcessDesk } from "../connectors/system/act.js";
import { SystemProbes } from "../connectors/system/probes.js";
import {
  call,
  chatWorld,
  FakeComputer,
  scriptedModel,
  tempRoot,
  type ModelRequest,
} from "./chat-agent-fixture.js";
import { fakeHost, fakeNow } from "./connectors-system-fixture.js";

function setup(
  options: {
    model?: ReturnType<typeof scriptedModel>;
    computer?: FakeComputer;
    trust?: boolean;
    system?: boolean;
  } = {},
) {
  const clock = { now: fakeNow };
  const host = fakeHost();
  host.now = () => clock.now;
  const root = tempRoot();
  const world = chatWorld(root, {
    now: () => clock.now,
    ...(options.computer ? { computer: options.computer } : {}),
  });
  const system = new ProcessDesk(new SystemProbes(host), {
    trust: options.trust ?? false,
  });
  const model = options.model ?? scriptedModel([]);
  const agent = new ChatAgent({
    world,
    model,
    root,
    ...(options.system === false ? {} : { system }),
  });
  return { clock, host, agent, model };
}

const toolNames = (request: ModelRequest) =>
  request.tools.map((tool) => tool.name);
/** What the tool said back, as the model's next request carries it. */
const toolResult = (request: ModelRequest, name: string) =>
  request.messages
    .filter((message) => message.role === "tool" && message.name === name)
    .map((message) => message.content)
    .join("\n");

describe("the process level in the chat", () => {
  it("offers a look and the process actions only where a system desk is given", async () => {
    const withDesk = setup({ model: scriptedModel([{ text: "Hi." }]) });
    await withDesk.agent.answer([], "hello", "chat");
    expect(toolNames(withDesk.model.requests[0]!)).toEqual(
      expect.arrayContaining(["system_look", "process_act"]),
    );
    const without = setup({
      model: scriptedModel([{ text: "Hi." }]),
      system: false,
    });
    await without.agent.answer([], "hello", "chat");
    expect(toolNames(without.model.requests[0]!)).not.toContain("system_look");
    expect(effectTools.has("process_act")).toBe(true);
    expect(effectTools.has("system_look")).toBe(false);
  });

  it("tells the model to debug the Mac with the look, never with the screen", () => {
    expect(chatAgentRules).toMatch(/system_look/);
    expect(chatAgentRules).toMatch(/process_act/);
    expect(chatAgentRules).not.toMatch(/[–—]/);
  });

  it("reads why the Mac is slow from the processes, as data", async () => {
    const model = scriptedModel([
      { calls: [call("system_look", { what: "processes" })] },
      { text: "Stonepad is at full CPU." },
    ]);
    const { agent, host } = setup({ model });
    const answer = await agent.answer([], "why is my Mac so slow?", "chat");
    expect(answer.text).toBe("Stonepad is at full CPU.");
    expect(toolResult(model.requests[1]!, "system_look")).toContain(
      "Stonepad (app): pid 4242, 98 percent CPU",
    );
    expect(host.signals).toEqual([]);
  });

  it("gives the model the arguments of a process with the credential hidden, not the whole result withheld", async () => {
    const model = scriptedModel([
      { calls: [call("system_look", { what: "processes", name: "syncd" })] },
      { text: "syncd is stopped." },
    ]);
    const { agent } = setup({ model });
    await agent.answer([], "is syncd still running?", "chat");
    const result = toolResult(model.requests[1]!, "system_look");
    expect(result).toContain("syncd: pid 7000");
    expect(result).not.toMatch(/withheld|hunter22x|fake0value0123/);
  });

  it("force quits only after the question, on the owner's own yes in the next message", async () => {
    const model = scriptedModel([
      {
        calls: [
          call("process_act", { action: "force_quit", name: "Stonepad" }),
        ],
      },
      {
        text: "Force quit Stonepad (pid 4242)? Changes that are not saved are lost. Say yes or no.",
      },
      {
        calls: [
          call("process_act", { action: "force_quit", name: "Stonepad" }),
        ],
      },
      { text: "Done, Stonepad is gone." },
    ]);
    const { agent, host, clock } = setup({ model });
    const first = await agent.answer([], "force quit Stonepad", "chat");
    expect(first.text).toMatch(/^Force quit Stonepad \(pid 4242\)\?/);
    expect(toolResult(model.requests[1]!, "process_act")).toMatch(
      /^Not done yet: this needs the owner's yes/,
    );
    expect(host.signals).toEqual([]);
    clock.now += 15_000;
    const history: ChatMessage[] = [
      { role: "user", text: "force quit Stonepad", at: fakeNow, via: "chat" },
      { role: "assistant", text: first.text, at: fakeNow + 1, via: "chat" },
    ];
    await agent.answer(history, "yes", "chat");
    expect(host.signals).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });

  it("gives a plain yes to the newest question, the force quit, and leaves the older computer question open", async () => {
    const computer = new FakeComputer()
      .run("send Sam the draft")
      .ask("approval", "Send this message to Sam?");
    let later = () => {};
    const model = scriptedModel([
      () => {
        // The model takes a moment: the force quit is asked after the computer's question.
        later();
        return {
          calls: [
            call("process_act", { action: "force_quit", name: "Stonepad" }),
          ],
        };
      },
      { text: "Force quit Stonepad? Say yes or no." },
      {
        calls: [
          call("answer_question", { answer: "yes" }),
          call("process_act", { action: "force_quit", name: "Stonepad" }),
        ],
      },
      { text: "Force quit Stonepad." },
    ]);
    const { agent, host, clock } = setup({ model, computer });
    later = () => {
      clock.now += 1_000;
    };
    await agent.answer([], "force quit Stonepad", "chat");
    clock.now += 15_000;
    await agent.answer([], "yes", "chat");
    expect(host.signals).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
    expect(computer.answers).toEqual([]);
    expect(computer.waiting).toBe("approval");
    expect(toolResult(model.requests[3]!, "answer_question")).toMatch(
      /^Refused: The owner's "yes" answers the newest question they saw: "Force quit Stonepad/,
    );
  });

  it("gives a plain yes to the computer task's question when it came after the force quit", async () => {
    const computer = new FakeComputer().run("buy the Aero 7 headphones");
    const model = scriptedModel([
      {
        calls: [
          call("process_act", { action: "force_quit", name: "Stonepad" }),
        ],
      },
      { text: "Force quit Stonepad (pid 4242)? Say yes or no." },
      {
        calls: [
          call("process_act", { action: "force_quit", name: "Stonepad" }),
        ],
      },
      { text: "It asks again." },
    ]);
    const { agent, host, clock } = setup({ model, computer });
    await agent.answer([], "force quit Stonepad", "chat");
    clock.now += 10_000;
    computer.ask(
      "approval",
      "Click Place order on shop.example? It spends 48 dollars. Say yes or no.",
    );
    // The service reads the graph again every two seconds.
    agent.refresh();
    clock.now += 10_000;
    await agent.answer([], "yes", "chat");
    expect(host.signals).toEqual([]);
    expect(toolResult(model.requests[3]!, "process_act")).toMatch(
      /^Not done: the owner's "yes" answers another question/,
    );
  });

  it("takes a yes for an older question only when the owner names it", async () => {
    const computer = new FakeComputer()
      .run("send Sam the draft")
      .ask("approval", "Send this message to Sam?");
    let later = () => {};
    const model = scriptedModel([
      () => {
        later();
        return {
          calls: [
            call("process_act", { action: "force_quit", name: "Stonepad" }),
          ],
        };
      },
      { text: "Force quit Stonepad? Say yes or no." },
      {
        calls: [
          call("answer_question", { answer: "yes, send it" }),
          call("process_act", { action: "force_quit", name: "Stonepad" }),
        ],
      },
      { text: "Sent it on. Stonepad still waits." },
    ]);
    const { agent, host, clock } = setup({ model, computer });
    later = () => {
      clock.now += 1_000;
    };
    await agent.answer([], "force quit Stonepad", "chat");
    clock.now += 15_000;
    await agent.answer([], "yes, send it", "chat");
    expect(computer.answers).toEqual(["yes, send it"]);
    expect(host.signals).toEqual([]);
  });

  it('lets the owner\'s "without saving" skip one question, for an app that they named', async () => {
    const model = scriptedModel([
      {
        calls: [
          call("process_act", { action: "force_quit", name: "Stonepad" }),
          call("process_act", { action: "force_quit", name: "Riverchat" }),
          call("process_act", { action: "force_quit", pid: 7000 }),
        ],
      },
      { text: "Stonepad is gone. The others need your yes." },
    ]);
    const { agent, host } = setup({ model });
    await agent.answer(
      [],
      "force quit Stonepad and Riverchat without saving",
      "chat",
    );
    expect(host.signals).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
    const results = model.requests[1]!.messages.filter(
      (message) => message.role === "tool",
    ).map((message) => message.content);
    expect(results[1]).toMatch(/^Not done yet: this needs the owner's yes/);
    expect(results[2]).toMatch(/^Not done yet: this needs the owner's yes/);
  });

  it("starts nothing in a turn where the owner said stop", async () => {
    const model = scriptedModel([
      { calls: [call("process_act", { action: "quit", name: "Stonepad" })] },
      { text: "Stopped." },
    ]);
    const { agent, host } = setup({ model });
    host.quitEnds.add(4242);
    await agent.answer([], "stop", "chat");
    expect(
      host.calls.some((line) => line.startsWith("/usr/bin/osascript")),
    ).toBe(false);
  });

  it("restarts an app behind the window in front while a computer task runs", async () => {
    const computer = new FakeComputer().run("search Aero 7 prices");
    const model = scriptedModel([
      { calls: [call("process_act", { action: "restart", name: "Stonepad" })] },
      { text: "Restarted." },
    ]);
    const { agent, host } = setup({ model, computer });
    host.quitEnds.add(4242);
    await agent.answer([], "restart Stonepad, it froze", "chat");
    expect(host.calls).toContain(
      "/usr/bin/open -g -a /Applications/Stonepad.app",
    );
  });
});
