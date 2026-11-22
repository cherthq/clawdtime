import { describe, expect, it } from "vitest";
import {
  admitBackgroundWorkflowAction,
  type BackgroundWorkflowBinding,
  type BackgroundWorkflowGrant,
  type BackgroundWorkflowRequest,
} from "../connectors/agents/background-workflow-policy.js";

const binding: BackgroundWorkflowBinding = {
  callId: "call-fixture",
  taskId: "task-fixture",
  toolCallId: "tool-fixture",
  driverInstanceId: "driver-fixture",
  driverGeneration: "generation-one",
  driverVersion: "0.55.0",
  bundleId: "com.example.TestEditor",
  pid: 321,
  processStartIdentity: "start-one",
  windowId: "window-one",
  observationId: "frame-one",
  observationFingerprint: "pixels-one",
};
const grant: BackgroundWorkflowGrant = {
  workflow: "codex-draft",
  qualificationId: "fixture-qualified",
  destinationId: "disposable-project",
  binding,
  observedAt: 1000,
  expiresAt: 3000,
  capabilities: [
    {
      purpose: "navigate",
      operation: "new-chat",
      elementToken: "new-chat-token",
    },
    {
      purpose: "draft",
      elementToken: "draft-token",
      allowedText: "Harmless unsent draft",
      keys: ["ArrowLeft"],
    },
    { purpose: "read-scroll", elementToken: "read-token", maxDeltaY: 100 },
  ],
};
const request: BackgroundWorkflowRequest = {
  binding,
  destinationId: grant.destinationId,
  delivery: "background",
  action: {
    type: "type",
    elementToken: "draft-token",
    text: "Harmless unsent draft",
  },
};
function admission(
  overrides: Partial<Parameters<typeof admitBackgroundWorkflowAction>[0]> = {},
) {
  return admitBackgroundWorkflowAction({
    grant,
    request,
    currentBinding: binding,
    currentDestinationId: grant.destinationId,
    qualifications: [
      {
        id: grant.qualificationId,
        workflow: grant.workflow,
        bundleId: binding.bundleId,
        driverVersion: binding.driverVersion,
      },
    ],
    now: 1500,
    signal: new AbortController().signal,
    ...overrides,
  });
}

describe("background workflow positive capability admission", () => {
  it("admits exact draft entry with independently current destination and all bindings", () => {
    expect(admission()).toEqual({ allowed: true, request });
  });
  it.each(Object.keys(binding) as (keyof BackgroundWorkflowBinding)[])(
    "refuses a changed %s in either fresh native evidence or requested action",
    (key) => {
      const changed = { ...binding, [key]: key === "pid" ? 999 : "different" };
      expect(admission({ currentBinding: changed })).toEqual({
        allowed: false,
        code: "target_changed",
      });
      expect(admission({ request: { ...request, binding: changed } })).toEqual({
        allowed: false,
        code: "target_changed",
      });
    },
  );
  it("does not accept a model-provided qualification or a new destination", () => {
    expect(admission({ qualifications: [] }).allowed).toBe(false);
    expect(admission({ currentDestinationId: "other-project" })).toEqual({
      allowed: false,
      code: "target_changed",
    });
    expect(
      admission({ request: { ...request, destinationId: "other-project" } })
        .allowed,
    ).toBe(false);
  });
  it("binds qualification to workflow, app and driver release", () => {
    for (const change of [
      { workflow: "messages-read" as const },
      { bundleId: "com.example.Other" },
      { driverVersion: "0.56.0" },
    ]) {
      expect(
        admission({
          qualifications: [
            {
              id: grant.qualificationId,
              workflow: grant.workflow,
              bundleId: binding.bundleId,
              driverVersion: binding.driverVersion,
              ...change,
            },
          ],
        }).allowed,
      ).toBe(false);
    }
  });
  it.each([999, 3000, 3001, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses stale/invalid clock %s",
    (now) => {
      expect(admission({ now })).toEqual({
        allowed: false,
        code: "stale_observation",
      });
    },
  );
  it("refuses Stop immediately and does not promote a long-lived grant", () => {
    expect(admission({ signal: AbortSignal.abort() })).toEqual({
      allowed: false,
      code: "stopped",
    });
    expect(admission({ grant: { ...grant, expiresAt: 60_000 } }).allowed).toBe(
      false,
    );
  });
  it.each([
    { type: "click", elementToken: "send-token" },
    { type: "click", x: 20, y: 30 },
    { type: "key", elementToken: "draft-token", key: "Return" },
    { type: "key", elementToken: "draft-token", key: "Enter" },
    { type: "key", elementToken: "draft-token", key: "Space" },
    { type: "hotkey", elementToken: "draft-token", keys: ["Meta", "Enter"] },
    {
      type: "type",
      elementToken: "draft-token",
      text: "Harmless unsent draft\n",
    },
    {
      type: "type",
      elementToken: "draft-token",
      text: "Harmless unsent draft\u2028",
    },
    { type: "type", elementToken: "draft-token", text: "Different message" },
    {
      type: "type",
      elementToken: "new-chat-token",
      text: "Harmless unsent draft",
    },
    { type: "key", elementToken: "new-chat-token", key: "ArrowLeft" },
    { type: "key", elementToken: "draft-token", key: "Backspace" },
    { type: "shell", command: "anything" },
    { type: "script", code: "anything" },
    { type: "launch", bundleId: "com.example.TestEditor" },
    [
      { type: "click", elementToken: "new-chat-token" },
      {
        type: "type",
        elementToken: "draft-token",
        text: "Harmless unsent draft",
      },
    ],
  ])(
    "refuses ungranted, submit-equivalent or unbounded operation %j",
    (action) => {
      expect(admission({ request: { ...request, action } }).allowed).toBe(
        false,
      );
    },
  );
  it("refuses foreground delivery and unsolicited extra arguments", () => {
    expect(
      admission({ request: { ...request, delivery: "foreground" } }).allowed,
    ).toBe(false);
    expect(
      admission({ request: { ...request, allowForegroundFallback: true } })
        .allowed,
    ).toBe(false);
    expect(
      admission({
        request: { ...request, action: { ...request.action, submit: true } },
      }).allowed,
    ).toBe(false);
  });
  it("requires navigation/editor and scroll operations to match distinct capability types", () => {
    for (const action of [
      { type: "click", elementToken: "new-chat-token" },
      { type: "click", elementToken: "draft-token" },
      { type: "key", elementToken: "draft-token", key: "ArrowLeft" },
      { type: "scroll", elementToken: "read-token", deltaY: -100 },
    ])
      expect(admission({ request: { ...request, action } }).allowed).toBe(true);
    for (const action of [
      { type: "click", elementToken: "read-token" },
      { type: "scroll", elementToken: "draft-token", deltaY: 100 },
      { type: "scroll", elementToken: "read-token", deltaY: 101 },
      { type: "scroll", elementToken: "read-token", deltaY: 0 },
    ])
      expect(admission({ request: { ...request, action } }).allowed).toBe(
        false,
      );
  });
  it("does not mint send authority from a capability label or ambiguous token", () => {
    expect(
      admission({
        grant: {
          ...grant,
          capabilities: [
            {
              purpose: "navigate",
              operation: "send",
              elementToken: "send-token",
            },
          ],
        },
      }).allowed,
    ).toBe(false);
    expect(
      admission({
        grant: {
          ...grant,
          capabilities: [grant.capabilities[0], grant.capabilities[0]],
        },
      }).allowed,
    ).toBe(false);
  });
  it("keeps Messages/email read-only and permits only explicitly scoped search text", () => {
    expect(
      admission({ grant: { ...grant, workflow: "messages-read" } }).allowed,
    ).toBe(false);
    expect(
      admission({ grant: { ...grant, workflow: "email-read" } }).allowed,
    ).toBe(false);
    const readGrant = {
      ...grant,
      workflow: "messages-read",
      capabilities: [
        {
          purpose: "navigate",
          operation: "select-test-conversation",
          elementToken: "conversation-token",
        },
        {
          purpose: "search",
          elementToken: "search-token",
          allowedText: "Fixture conversation",
        },
      ],
    };
    expect(
      admission({
        grant: readGrant,
        qualifications: [
          {
            id: grant.qualificationId,
            workflow: "messages-read",
            bundleId: binding.bundleId,
            driverVersion: binding.driverVersion,
          },
        ],
        request: {
          ...request,
          action: {
            type: "type",
            elementToken: "search-token",
            text: "Fixture conversation",
          },
        },
      }).allowed,
    ).toBe(true);
    expect(
      admission({
        grant: readGrant,
        qualifications: [
          {
            id: grant.qualificationId,
            workflow: "messages-read",
            bundleId: binding.bundleId,
            driverVersion: binding.driverVersion,
          },
        ],
        request: {
          ...request,
          action: {
            type: "type",
            elementToken: "search-token",
            text: "Someone else",
          },
        },
      }).allowed,
    ).toBe(false);
    expect(
      admission({ grant: { ...readGrant, workflow: "codex-draft" } }).allowed,
    ).toBe(false);
  });
});

describe("qualified exact pixel draft entry", () => {
  const geometry = {
    editorId: "composer",
    screenshotWidth: 2000,
    screenshotHeight: 1000,
    bounds: { x: 400, y: 200, width: 600, height: 200 },
  };
  const pixelGrant = {
    ...grant,
    capabilities: [
      {
        purpose: "pixel-draft",
        geometry,
        allowedText: "Harmless unsent draft",
      },
    ],
  };
  const action = {
    type: "pixel-type",
    editorId: "composer",
    x: 700,
    y: 300,
    text: "Harmless unsent draft",
  };
  const pixelRequest = { ...request, action };
  const qualifications = [
    {
      id: grant.qualificationId,
      workflow: grant.workflow,
      bundleId: binding.bundleId,
      driverVersion: binding.driverVersion,
      pixelDraft: true as const,
    },
  ];
  const check = (
    overrides: Partial<
      Parameters<typeof admitBackgroundWorkflowAction>[0]
    > = {},
  ) =>
    admission({
      grant: pixelGrant,
      request: pixelRequest,
      qualifications,
      currentEditorGeometry: geometry,
      ...overrides,
    });
  it("permits one exact text entry only with separately qualified matching editor geometry", () => {
    expect(check()).toEqual({ allowed: true, request: pixelRequest });
    expect(
      check({
        qualifications: qualifications.map(
          ({ pixelDraft: _omit, ...item }) => item,
        ),
      }).allowed,
    ).toBe(false);
    expect(check({ currentEditorGeometry: undefined }).allowed).toBe(false);
    expect(
      check({ qualifications: [{ ...qualifications[0]!, bundleId: "other" }] })
        .allowed,
    ).toBe(false);
  });
  it.each([0, -1, 701, 2001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects noncanonical/out-of-frame x=%s",
    (x) => {
      expect(
        check({ request: { ...pixelRequest, action: { ...action, x } } })
          .allowed,
      ).toBe(false);
    },
  );
  it.each([
    { ...geometry, screenshotWidth: 0 },
    { ...geometry, screenshotWidth: 800 },
    { ...geometry, screenshotWidth: 2001 },
    { ...geometry, editorId: "other-editor" },
    { ...geometry, bounds: { ...geometry.bounds, x: -1 } },
    { ...geometry, bounds: { ...geometry.bounds, x: 401 } },
    { ...geometry, bounds: { ...geometry.bounds, width: 0 } },
    { ...geometry, bounds: { ...geometry.bounds, width: Infinity } },
    { ...geometry, bounds: { ...geometry.bounds, height: 2000 } },
  ])(
    "rejects changed or malformed independent geometry %j",
    (currentEditorGeometry) => {
      expect(check({ currentEditorGeometry }).allowed).toBe(false);
    },
  );
  it("rejects forged plan geometry, foreground, submit text and generic pixel clicks", () => {
    for (const modified of [
      { ...action, geometry },
      { ...action, elementToken: "ignored" },
      { ...action, text: "Other text" },
      { ...action, text: "Harmless unsent draft\n" },
      { type: "click", x: 700, y: 300 },
    ])
      expect(
        check({ request: { ...pixelRequest, action: modified } }).allowed,
      ).toBe(false);
    expect(
      check({ request: { ...pixelRequest, delivery: "foreground" } }).allowed,
    ).toBe(false);
    expect(
      check({
        grant: { ...pixelGrant, workflow: "messages-read" },
        qualifications: [{ ...qualifications[0]!, workflow: "messages-read" }],
      }).allowed,
    ).toBe(false);
    expect(
      check({
        currentBinding: { ...binding, observationFingerprint: "new-pixels" },
      }).allowed,
    ).toBe(false);
  });
});
