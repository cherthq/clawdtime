import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
const store = new Store(),
  transport = new SimulationTransport(),
  service = new ClawdTime(store, transport),
  device = new SimulatedDevice(),
  control = new ControlCoordinator(store, device),
  // An explicitly scripted fixture, never the production conversation agent.
  human = new HumanRouter(service, control, {
    observe: async (lease) => ({
      frame: await device.frame(lease),
      dataUrl: "data:image/jpeg;base64,c3ludGhldGlj",
    }),
    run: async (turn) => {
      if (demoTurn++ === 0) {
        const { frame } = await turn.tools.observe();
        await turn.tools.act(frame.id, { kind: "click", x: 0.5, y: 0.5 });
        return {
          reply: "Synthetic input observed; this is not physical acceptance.",
        };
      }
      await turn.tools.feedback({ kind: "answer" });
      return { reply: "Returning your answer to the same simulated session." };
    },
  });
let demoTurn = 0;
const binding = {
  memberId: "demo_member",
  recipient: "+15555550100",
  conversationId: "iMessage;-;+15555550100",
  lineId: "demo_line",
  deviceId: "demo_mac",
  displayId: "1",
};
const invite = service.createPairingInvite(binding),
  claim = service.claimPairing({
    token: invite.token,
    deviceId: binding.deviceId,
    displayId: binding.displayId,
    allowView: true,
    allowControl: true,
  });
const connected = service.registerSession(claim.token, {
  adapter: "codex",
  adapterVersion: "simulation",
  projectRoot: "/disposable/demo",
  externalSessionId: "demo_session",
  hostId: "demo_host",
  capabilities: { cooperativePause: true, polling: true },
});
service.yieldSession(connected.token);
const request = service.requestAttention(connected.token, {
  taskId: "demo_task",
  idempotencyKey: "demo_attention",
  reason: "decision",
  question: "Which color should this disposable UI use?",
});
await service.drain();
service.observeCall(request.id, "connected", true);
const sender = {
  memberId: binding.memberId,
  lineId: binding.lineId,
  conversationId: binding.conversationId,
};
await human.receive({
  ...sender,
  eventId: "demo_click",
  requestId: request.id,
  channel: "text",
  text: "Click the center of the fixture.",
});
await human.receive({
  ...sender,
  eventId: "demo_answer",
  requestId: request.id,
  channel: "text",
  text: "Use green.",
});
const response = service.result(connected.token, request.id).response!;
service.ack(connected.token, request.id, response.id);
service.resume(
  connected.token,
  request.id,
  service.authenticateSession(connected.token).controlEpoch,
);
service.complete(
  connected.token,
  request.id,
  "Disposable demo completed using green.",
);
await service.drain();
console.log(
  JSON.stringify(
    {
      mode: "simulation",
      realCall: false,
      requestState: service.status(connected.token, request.id).state,
      calls: transport.calls.length,
      inputs: device.inputs.length,
      responses: 1,
      messages: transport.messages.length,
    },
    null,
    2,
  ),
);
store.close();
