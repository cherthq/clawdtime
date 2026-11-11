import type {
  ConversationAgent,
  ConversationTurn,
  Observation,
} from "../src/control/conversation.js";
import type {
  ControlLease,
  DevicePort,
  InputAction,
} from "../src/contracts.js";
import type { SingleActionPlanner } from "../src/control/human-router.js";
/** Test-only translation of historical command fixtures; production has no parser. */
export class ScriptedConversationAgent implements ConversationAgent {
  private lease?: ControlLease;
  constructor(
    readonly device: DevicePort,
    readonly script?: (turn: ConversationTurn) => Promise<{ reply: string }>,
    readonly planner?: SingleActionPlanner,
  ) {}
  async observe(lease: ControlLease): Promise<Observation> {
    this.lease = lease;
    return {
      frame: await this.device.frame(lease),
      dataUrl: "data:image/jpeg;base64,AQ==",
    };
  }
  async run(turn: ConversationTurn) {
    if (this.script) return this.script(turn);
    if (/^(answer|correction): /i.test(turn.text)) {
      await turn.tools.feedback({
        kind: /^correction:/i.test(turn.text) ? "correction" : "answer",
      });
      return { reply: "I've passed your feedback to the coding agent." };
    }
    const image = await turn.tools.observe();
    let action: InputAction;
    if (/^do: /i.test(turn.text) && this.planner)
      action = (await this.planner.plan(turn.text.slice(4), this.lease!))
        .action;
    else if (/^type: /i.test(turn.text))
      action = { kind: "type", text: turn.text.slice(6) };
    else if (/^click /i.test(turn.text)) {
      const [, x, y] = turn.text.split(" ");
      action = { kind: "click", x: Number(x), y: Number(y) };
    } else if (/^scroll /i.test(turn.text)) {
      const [, delta, , x, y] = turn.text.split(" ");
      action = {
        kind: "scroll",
        deltaY: Number(delta),
        x: Number(x),
        y: Number(y),
      };
    } else return { reply: "What would you like to do?" };
    await turn.tools.act(image.frame.id, action);
    return { reply: "The input was observed. Please inspect the screen." };
  }
}
