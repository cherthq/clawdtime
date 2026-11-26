import { describe, expect, it } from "vitest";
import { executeConversationCommand } from "../connectors/shared/conversation.js";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import {
  protocolOptions,
  sessionCapabilities,
} from "../connectors/shared/protocol.js";

const command = {
  version: 1,
  commandId: "stable",
  expectedRevision: 0,
  sourceFrameId: "frame",
  geometryGeneration: "geometry",
  op: "overview",
};
const status = {
  version: 1,
  sessionId: "s",
  deviceId: "d",
  leaseId: "l",
  revision: 0,
  state: "live",
  surface: { kind: "display", id: "2", displayId: 2 },
  sourceFrameId: "frame",
  capturedAt: 100,
  geometryGeneration: "geometry",
  contentRevision: "content",
  crop: { x: 0, y: 0, width: 1, height: 1 },
  source: null,
  output: {
    width: 1280,
    height: 720,
    viewport: { x: 0, y: 0, width: 1280, height: 720 },
  },
  pinned: false,
  moving: false,
  annotations: [],
  context: null,
};

describe("screen camera connector negotiation", () => {
  it("requires explicit new v2 surface selection, without inferring native input", () => {
    expect(protocolOptions({}).screenCamera).toBeUndefined();
    expect(
      sessionCapabilities(protocolOptions({})).screenCameraVersion,
    ).toBeUndefined();
    const options = protocolOptions({
      "screen-camera": "true",
      "camera-display": "2",
      "camera-window": "14",
      "camera-owner-pid": "71",
    });
    expect(options.screenCamera).toEqual({
      version: 1,
      surface: { kind: "window", id: "14", displayId: 2, ownerPid: 71 },
    });
    expect(sessionCapabilities(options)).toMatchObject({
      screenCameraVersion: 1,
      nativeControl: "none",
      sharedSurface: false,
    });
    expect(
      protocolOptions({ "screen-camera": "true", "camera-display": "2" })
        .screenCamera,
    ).toEqual({
      version: 1,
      surface: { kind: "display", id: "2", displayId: 2 },
    });
    for (const flags of [
      { "screen-camera": "perhaps" },
      { "screen-camera": "true" },
      { "camera-display": "2" },
      {
        "screen-camera": "true",
        "camera-display": "2",
        "protocol-version": "1",
      },
      { "screen-camera": "true", "camera-display": "NaN" },
      { "screen-camera": "true", "camera-display": "2", "camera-window": "14" },
      {
        "screen-camera": "true",
        "camera-display": "2",
        "camera-owner-pid": "71",
      },
      {
        "screen-camera": "true",
        "camera-display": "2",
        "camera-window": "-1",
        "camera-owner-pid": "71",
      },
      { "screen-camera": "true", "camera-display": "4294967296" },
      {
        "screen-camera": "true",
        "camera-display": "2",
        runner: "remote-documents",
      },
    ] as Record<string, string>[])
      expect(() => protocolOptions(flags)).toThrow();
  });

  it.each([{}, { version: 2 }, { version: 1, sessionId: "s", deviceId: "d" }])(
    "refuses unsupported/malformed status %j before a mutation",
    async (status) => {
      const calls: string[] = [];
      const client = new ClawdTimeClient(
        "http://127.0.0.1:3310",
        "synthetic",
        (async (url, init) => {
          calls.push(`${init?.method} ${url}`);
          return new Response(JSON.stringify(status));
        }) as typeof fetch,
      );
      await expect(client.screenCamera("r", command)).rejects.toThrow(
        "not negotiated",
      );
      expect(calls).toEqual([
        "GET http://127.0.0.1:3310/api/attention/r/conversation/camera",
      ]);
    },
  );

  it("negotiates each exact request and never retries an uncertain mutation", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      body: unknown;
    }> = [];
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic",
      (async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body && JSON.parse(String(init.body)),
        });
        if (init?.method === "POST")
          throw new Error("synthetic uncertain write");
        return new Response(JSON.stringify(status));
      }) as typeof fetch,
    );
    await expect(client.screenCamera("one", command)).rejects.toThrow(
      "uncertain write",
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]?.body).toEqual(command);
    await client.screenCamera("two");
    expect(calls[2]?.url).toContain("/two/conversation/camera");
    expect(calls).toHaveLength(3);
  });

  it("rejects presentation input before the existing action endpoint on older camera peers", async () => {
    const calls: string[] = [];
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic",
      (async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({}));
      }) as typeof fetch,
    );
    await expect(
      client.conversationOperation("r", "act", {
        presentation: {
          revision: 1,
          geometryGeneration: "geometry",
          sourceFrameId: "f",
        },
        action: { kind: "click", x: 0.2, y: 0.3 },
      }),
    ).rejects.toThrow("not negotiated");
    expect(calls).toEqual([
      "http://127.0.0.1:3310/api/attention/r/conversation/camera",
    ]);
  });
  it("uses one shared command schema for the connector boundary and preserves frame mapping references", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic",
      (async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body && JSON.parse(String(init.body)),
        });
        const response =
          init?.method === "GET"
            ? status
            : String(url).endsWith("/camera")
              ? {
                  version: 1,
                  commandId: "stable",
                  revision: 1,
                  state: "accepted",
                }
              : { state: "submitted" };
        return new Response(JSON.stringify(response));
      }) as typeof fetch,
    );
    await expect(
      executeConversationCommand(client, "screen_camera_command", {
        requestId: "r",
        command: {
          ...command,
          op: "focus_region",
          rect: { x: 0.9, y: 0, width: 0.5, height: 1 },
        },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expect(
      executeConversationCommand(client, "act_on_shared_screen", {
        requestId: "r",
        epoch: 3,
        actionId: "action",
        frameId: "frame",
        presentation: {
          revision: 1,
          geometryGeneration: "geometry",
          sourceFrameId: "frame",
        },
        action: { kind: "type", text: "synthetic" },
      }),
    ).rejects.toThrow("click or scroll");
    expect(calls).toHaveLength(0);
    const receipt = await executeConversationCommand(
      client,
      "screen_camera_command",
      { requestId: "r", command },
    );
    expect(receipt).toEqual({
      version: 1,
      commandId: "stable",
      revision: 1,
      state: "accepted",
    });
    expect(calls[1]?.body).toEqual(command);
    const presentation = {
      revision: 1,
      geometryGeneration: "geometry",
      sourceFrameId: "frame",
    };
    await executeConversationCommand(client, "act_on_shared_screen", {
      requestId: "r",
      epoch: 3,
      actionId: "action",
      frameId: "frame",
      presentation,
      action: { kind: "click", x: 0.2, y: 0.3 },
    });
    expect(calls.at(-1)).toMatchObject({
      url: "http://127.0.0.1:3310/api/attention/r/conversation/act",
      body: { presentation, actionId: "action", epoch: 3, frameId: "frame" },
    });
  });
});
