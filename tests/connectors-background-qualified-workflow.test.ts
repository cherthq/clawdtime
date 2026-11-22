import { describe, it, expect, vi } from "vitest";
import {
  QualifiedBackgroundWorkflow,
  admitQualifiedGrant,
  summarizeBackgroundObservation,
  QualifiedBackgroundObservationError,
  QualifiedNativeMenuError,
  type QualifiedBackgroundWorkflowConfig,
  type QualifiedBackgroundWorkflowHost,
  type QualifiedBackgroundGrant,
  type QualifiedWorkflowPort,
} from "../connectors/agents/background-qualified-workflow.js";
import type { BackgroundTaskContext } from "../src/control/background-runtime.js";
const config: QualifiedBackgroundWorkflowConfig = {
  driverVersion: "0.55.0",
  messages: {
    bundleId: "com.example.Messages",
    appVersion: "1.0",
    qualificationId: "messages-q",
    contact: "Test Contact",
  },
  codex: {
    bundleId: "com.example.Codex",
    appVersion: "2.0",
    qualificationId: "codex-q",
    destination: "Test Project",
  },
};
const good = {
  dispatch: "returned",
  code: "returned",
  effect: "unverifiable",
  driverVerified: false,
  workflowVerified: false,
} as const;
const rect = { x: 40, y: 100, w: 200, h: 60 };
const element = (role: string, label: string, value?: string) => ({
  role,
  label,
  ...(value ? { value } : {}),
  enabled: true,
  frame: { ...rect },
  screenshot_frame: { ...rect },
});
function fixture(kind: "messages-read" | "codex-draft" = "messages-read") {
  let now = 1000,
    phase = 0,
    serial = 0,
    live = true;
  const cfg = kind === "messages-read" ? config.messages : config.codex;
  const scope = {
    callId: "call-1",
    toolCallId: "tool-1",
    taskId: "task-1",
    driverInstanceId: "driver-1",
    driverGeneration: "generation-1",
    driverVersion: "0.55.0",
    bundleId: cfg.bundleId,
    pid: 100,
    processStartIdentity: "lifetime-1",
    windowId: "200",
  };
  const receipts: { id: string; state: string }[] = [];
  const context: BackgroundTaskContext = {
    callId: scope.callId,
    toolCallId: scope.toolCallId,
    taskId: scope.taskId,
    sessionId: "session-1",
    expiresAt: 999999,
    isLive: () => live,
    reserve: vi.fn(() => {
      const id = `receipt-${receipts.length}`;
      receipts.push({ id, state: "reserved" });
      return id;
    }),
    returned: vi.fn((id, dispatch) => {
      receipts.find((r) => r.id === id)!.state = dispatch;
    }),
    verified: vi.fn((id) => {
      receipts.find((r) => r.id === id)!.state = "verified";
    }),
  };
  let mutate: (state: any) => void = () => {};
  let imageChange = false;
  let dynamicPhase: number | undefined;
  const observe = vi.fn(async () => {
    serial++;
    const base = 100 + serial * 10;
    const elements =
      kind === "messages-read"
        ? [element("AXStaticText", "Test Contact, latest preview")]
        : phase === 0
          ? [
              {
                ...element("AXMenuItem", "New Chat"),
                title: "New Chat",
                depth: 3,
                element_index: base + 3,
                parent_index: base + 2,
                actions: ["AXCancel", "AXPress", "AXPick"],
              },
              {
                role: "AXMenu",
                depth: 2,
                element_index: base + 2,
                parent_index: base + 1,
              },
              {
                role: "AXMenuBarItem",
                label: "File",
                title: "File",
                depth: 1,
                element_index: base + 1,
                parent_index: base,
              },
              { role: "AXMenuBar", depth: 0, element_index: base },
            ]
          : phase === 1
            ? [element("AXTextArea", "Do anything")]
            : [element("AXTextArea", "Do anything", "Test draft")];
    const state = {
      pid: 100,
      window_id: 200,
      snapshot_id: `s${serial}`,
      screenshot_width: 800,
      screenshot_height: 600,
      screenshot_frame_valid: true,
      screenshot_mime_type: "image/png",
      window_bounds: { x: 0, y: 0, width: 800, height: 600 },
      elements: elements.map((e, i) => ({
        ...e,
        element_token: `s${serial}:${i}`,
      })),
    };
    mutate(state);
    return {
      isError: false,
      degraded: false,
      structuredJson: JSON.stringify(state),
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from(
            `frame-${phase}-${imageChange && (dynamicPhase === undefined || dynamicPhase === phase) ? serial : 0}`,
          ).toString("base64"),
        },
      ],
    };
  });
  const port: QualifiedWorkflowPort = {
    startSession: vi.fn(async () => true),
    endSession: vi.fn(async () => ({ quiescence: "known" as const })),
    launchQualifiedApp: vi.fn(async () => ({
      ...good,
      launched: { pid: 100, bundleId: cfg.bundleId, windowIds: ["200"] },
    })),
    observe,
    clickElement: vi.fn(async () => {
      phase = 1;
      return good;
    }),
    clickQualifiedPoint: vi.fn(async () => {
      phase = 1;
      return good;
    }),
    typePixelDraft: vi.fn(async () => {
      phase = 2;
      return good;
    }),
  };
  const grants: QualifiedBackgroundGrant[] = [];
  const disarm = vi.fn();
  const host: QualifiedBackgroundWorkflowHost = {
    verifyLaunchedApplication: vi.fn(
      async (_workflow, _context, signal, candidate) => {
        signal.throwIfAborted();
        if (
          candidate.pid !== 100 ||
          candidate.bundleId !== cfg.bundleId ||
          !candidate.windowIds.includes("200")
        )
          throw Error("Qualified application binding changed.");
      },
    ),
    bindFreshTarget: vi.fn(async () => ({
      scope: { ...scope },
      appVersion: cfg.appVersion,
    })),
    present: vi.fn(async () => {}),
    verifySurface: vi.fn(async () => true),
    armGrant: vi.fn((g) => {
      grants.push(g);
      return disarm;
    }),
  };
  const planner = {
    plan: vi.fn(async () =>
      kind === "messages-read"
        ? ({ kind } as const)
        : ({ kind, text: "Test draft" } as const),
    ),
    verify: vi.fn(async () => ({
      verified: true,
      summary:
        kind === "messages-read"
          ? "Selected conversation reviewed."
          : "Unsent draft prepared.",
    })),
  };
  const settleWait = vi.fn(async (delayMs: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    now += delayMs;
  });
  const worker = new QualifiedBackgroundWorkflow(
    config,
    port,
    planner,
    host,
    () => now,
    settleWait,
  );
  return {
    worker,
    settleWait,
    port,
    host,
    planner,
    context,
    receipts,
    grants,
    disarm,
    scope,
    observe,
    setMutate: (f: typeof mutate) => {
      mutate = f;
    },
    setNow: (n: number) => {
      now = n;
    },
    setLive: (b: boolean) => {
      live = b;
    },
    setImageChange: (onlyPhase?: number) => {
      imageChange = true;
      dynamicPhase = onlyPhase;
    },
    run: () =>
      worker.run(
        "Test requested workflow",
        context,
        new AbortController().signal,
      ),
  };
}

describe("qualified deterministic background workflows", () => {
  it("selects only the configured Messages row by qualified screenshot pixels and verifies independently", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      verified: true,
      summary: "Selected conversation reviewed.",
    });
    expect(f.port.clickQualifiedPoint).toHaveBeenCalledTimes(1);
    expect(f.port.clickElement).not.toHaveBeenCalled();
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.receipts.map((r) => r.state)).toEqual(["verified", "verified"]);
    expect(f.observe).toHaveBeenCalledTimes(3);
    expect(f.grants[0]!.binding.observationId).toBeTruthy();
    expect(f.grants[0]!.action.geometry?.editorId).toBe("s2:0");
    expect(f.disarm).toHaveBeenCalledTimes(1);
    expect(f.planner.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDestination: "Test Contact",
        kind: "messages-read",
      }),
      expect.any(AbortSignal),
    );
  });
  it("reads an already selected exact conversation without any input or sidebar row", async () => {
    const f = fixture();
    f.setMutate((s) => {
      s.elements = [
        element("AXWindow", "Test Contact"),
        {
          ...element("AXPopUpButton", "Test Contact, conversation details"),
          frame: { x: 400, y: 20, w: 100, h: 30 },
          screenshot_frame: { x: 400, y: 20, w: 100, h: 30 },
        },
      ];
    });
    expect((await f.run()).verified).toBe(true);
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
    expect(f.port.clickElement).not.toHaveBeenCalled();
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.host.armGrant).not.toHaveBeenCalled();
    expect(f.receipts.map((r) => r.state)).toEqual(["verified"]);
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.host.verifySurface).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "messages-selected",
        destination: "Test Contact",
        control: expect.objectContaining({ role: "AXPopUpButton" }),
      }),
      expect.any(AbortSignal),
    );
  });
  it.each([
    "wrong window",
    "generic body",
    "sidebar only",
    "disabled header",
    "duplicate header",
    "body-position header",
  ])(
    "does not infer already-selected conversation from %s",
    async (variant) => {
      const f = fixture();
      f.setMutate((s) => {
        const window = element(
          "AXWindow",
          variant === "wrong window" ? "Different Contact" : "Test Contact",
        );
        const header = {
          ...element("AXPopUpButton", "Test Contact, conversation details"),
          frame: { x: 400, y: 20, w: 100, h: 30 },
          screenshot_frame: { x: 400, y: 20, w: 100, h: 30 },
        };
        if (variant === "generic body") header.role = "AXStaticText";
        if (variant === "disabled header") header.enabled = false;
        if (variant === "body-position header")
          header.frame.y = header.screenshot_frame.y = 400;
        s.elements =
          variant === "sidebar only"
            ? [element("AXStaticText", "Test Contact")]
            : [
                window,
                header,
                ...(variant === "duplicate header" ? [header] : []),
              ];
        if (variant === "generic body") header.label = "Test Contact";
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
      expect(f.planner.verify).not.toHaveBeenCalled();
    },
  );
  it("requires screenshot corroboration of the already-selected right pane", async () => {
    const f = fixture();
    f.setMutate((s) => {
      s.elements = [
        element("AXWindow", "Test Contact"),
        {
          ...element("AXPopUpButton", "Test Contact, conversation details"),
          frame: { x: 400, y: 20, w: 100, h: 30 },
          screenshot_frame: { x: 400, y: 20, w: 100, h: 30 },
        },
      ];
    });
    vi.mocked(f.host.verifySurface).mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow("did not corroborate");
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
    expect(f.planner.verify).not.toHaveBeenCalled();
  });
  it("uses native New Chat AXPress and one exact unsent pixel draft, never submits", async () => {
    const f = fixture("codex-draft");
    await f.run();
    expect(f.port.clickElement).toHaveBeenCalledWith(
      expect.objectContaining({ elementToken: "s2:0" }),
      expect.any(AbortSignal),
    );
    expect(f.port.typePixelDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Test draft",
        geometry: expect.objectContaining({ editorId: "s4:0" }),
      }),
      expect.any(AbortSignal),
    );
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
    expect(f.receipts.map((r) => r.state)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
    expect(f.host.verifySurface).toHaveBeenCalledTimes(3);
    expect(f.observe).toHaveBeenCalledTimes(5);
  });
  it("settles old chat into the expected empty composer without repeating New Chat", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.snapshot_id === "s3") {
        s.elements[0].label = "Old chat composer";
        s.elements[0].value = "Old chat composer";
      }
    });
    expect((await f.run()).verified).toBe(true);
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.typePixelDraft).toHaveBeenCalledTimes(1);
    expect(f.observe).toHaveBeenCalledTimes(6);
    expect(f.settleWait).toHaveBeenCalledTimes(1);
    expect(f.settleWait).toHaveBeenCalledWith(250, expect.any(AbortSignal));
    expect(f.receipts.map((r) => r.state)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
  });
  it("leaves navigation unresolved when the exact empty composer never appears in four reads", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.elements[0].role === "AXTextArea") {
        s.elements[0].label = "Different composer";
        s.elements[0].value = "Different composer";
      }
    });
    await expect(f.run()).rejects.toThrow("bounded observation settling");
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.observe).toHaveBeenCalledTimes(6);
    expect(f.settleWait.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 750]);
    expect(f.receipts.map((r) => r.state)).toEqual(["verified", "returned"]);
    expect(f.host.verifySurface).toHaveBeenCalledTimes(1);
  });
  it("Stop during a settle wait prevents another observation or any typing", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.snapshot_id === "s3") s.elements[0].label = "Different composer";
    });
    f.settleWait.mockImplementation(async (_ms, signal) => {
      f.worker.stop();
      signal.throwIfAborted();
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.observe).toHaveBeenCalledTimes(3);
    expect(f.receipts.map((r) => r.state)).toEqual(["verified", "returned"]);
  });
  it("does not retry ambiguous composer observations", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.snapshot_id === "s3")
        s.elements.push({ ...s.elements[0], element_token: "s3:99" });
    });
    await expect(f.run()).rejects.toThrow("ambiguous");
    expect(f.observe).toHaveBeenCalledTimes(3);
    expect(f.settleWait).not.toHaveBeenCalled();
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.receipts[1]!.state).toBe("returned");
  });
  it("call revocation during settling blocks future reads and typing", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.snapshot_id === "s3") s.elements[0].label = "Different composer";
    });
    f.settleWait.mockImplementation(async () => {
      f.setLive(false);
    });
    await expect(f.run()).rejects.toThrow("authority expired");
    expect(f.observe).toHaveBeenCalledTimes(3);
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
  });
  it("the three-second observation deadline also bounds slow fresh reads", async () => {
    const f = fixture("codex-draft");
    let time = 1000;
    f.setMutate((s) => {
      if (s.elements[0].role === "AXTextArea") {
        s.elements[0].label = "Different composer";
        time += 1400;
        f.setNow(time);
      }
    });
    f.settleWait.mockImplementation(async (ms, signal) => {
      signal.throwIfAborted();
      time += ms;
      f.setNow(time);
    });
    await expect(f.run()).rejects.toThrow("bounded observation settling");
    expect(f.observe).toHaveBeenCalledTimes(4);
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
  });
  it("an apparent empty composer still requires independent project screenshot verification before typing", async () => {
    const f = fixture("codex-draft");
    vi.mocked(f.host.verifySurface).mockImplementation(
      async (input) => input.phase !== "codex-empty",
    );
    await expect(f.run()).rejects.toThrow("did not corroborate");
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.receipts.map((r) => r.state)).toEqual(["verified", "returned"]);
  });
  it("marks only the fully qualified native New Chat reservation as navigation", async () => {
    const f = fixture("codex-draft");
    await f.run();
    const reserved = vi
      .mocked(f.context.reserve)
      .mock.calls.map(
        ([payload]) =>
          payload as { operation: string; action?: { type: string } },
      );
    expect(reserved.map((r) => r.operation)).toEqual([
      "launch_app",
      "codex_new_chat_navigation",
      "type-pixel-draft",
    ]);
    expect(reserved[1]!.action?.type).toBe("click-element");
    expect(reserved[2]!.action?.type).toBe("type-pixel-draft");
  });
  it("never classifies a qualified Messages pixel selection as New Chat navigation", async () => {
    const f = fixture();
    await f.run();
    const reserved = vi
      .mocked(f.context.reserve)
      .mock.calls.map(([payload]) => payload as { operation: string });
    expect(reserved.map((r) => r.operation)).toEqual([
      "launch_app",
      "click-point",
    ]);
  });
  it("does not persist a navigation reservation when native ancestry qualification fails", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.snapshot_id === "s2") s.elements[2].label = "Other menu";
    });
    await expect(f.run()).rejects.toThrow();
    expect(
      vi
        .mocked(f.context.reserve)
        .mock.calls.map(
          ([payload]) => (payload as { operation: string }).operation,
        ),
    ).toEqual(["launch_app"]);
  });
  it("passes private destination constraints to workflow classification", async () => {
    const f = fixture();
    await f.run();
    expect(f.planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedMessagesContact: "Test Contact",
        authorizedCodexDestination: "Test Project",
      }),
      expect.any(AbortSignal),
    );
  });
  it("blocked intent opens no daemon session or apps", async () => {
    const f = fixture();
    vi.mocked(f.planner.plan).mockResolvedValue({
      kind: "blocked",
      reason: "Different contact requested.",
    } as never);
    expect((await f.run()).verified).toBe(false);
    expect(f.port.startSession).not.toHaveBeenCalled();
    expect(f.context.reserve).not.toHaveBeenCalled();
  });
  it("freshens after slow vision without reusing a token or stale grant", async () => {
    const f = fixture();
    vi.mocked(f.host.verifySurface).mockImplementation(async () => {
      f.setNow(10000);
      return true;
    });
    await f.run();
    expect(f.grants[0]!.observedAt).toBe(10000);
    expect(f.grants[0]!.action.geometry?.editorId).toBe("s2:0");
  });
  it("allows changing unrelated current-chat pixels only for the exact native New Chat and remaps once", async () => {
    const f = fixture("codex-draft");
    f.setImageChange(0);
    expect((await f.run()).verified).toBe(true);
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.clickElement).toHaveBeenCalledWith(
      expect.objectContaining({ elementToken: "s2:0" }),
      expect.any(AbortSignal),
    );
    expect(f.port.typePixelDraft).toHaveBeenCalledTimes(1);
    expect(f.receipts.map((r) => r.state)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
  });
  it.each([
    "disabled",
    "missing enabled",
    "different label",
    "different role",
    "missing AXPress",
    "changed frame",
    "changed value",
    "duplicate disabled menu",
  ])("denies changed fresh native New Chat: %s", async (change) => {
    const f = fixture("codex-draft");
    f.setImageChange(0);
    f.setMutate((s) => {
      if (s.snapshot_id !== "s2") return;
      const menu = s.elements[0];
      if (change === "disabled") menu.enabled = false;
      if (change === "missing enabled") delete menu.enabled;
      if (change === "different label") menu.label = "Other Action";
      if (change === "different role") menu.role = "AXButton";
      if (change === "missing AXPress") menu.actions = [];
      if (change === "changed frame") menu.frame.x++;
      if (change === "changed value") menu.value = "changed";
      if (change === "duplicate disabled menu")
        s.elements.push({ ...menu, enabled: false, element_token: "s2:1" });
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.port.clickElement).not.toHaveBeenCalled();
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.host.armGrant).not.toHaveBeenCalled();
  });
  it("remaps snapshot-local native indexes only after proving the same File menu ancestry", async () => {
    const f = fixture("codex-draft");
    f.setImageChange(0);
    const indexes: number[][] = [];
    f.setMutate((s) => {
      if (s.elements[0].role === "AXMenuItem")
        indexes.push(s.elements.map((e: any) => e.element_index));
    });
    await f.run();
    expect(indexes).toEqual([
      [113, 112, 111, 110],
      [123, 122, 121, 120],
    ]);
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.clickElement).toHaveBeenCalledWith(
      expect.objectContaining({ elementToken: "s2:0" }),
      expect.any(AbortSignal),
    );
  });
  it.each([
    "wrong File menu",
    "missing parent",
    "duplicate index",
    "cycle",
    "missing root",
    "wrong container role",
    "invented menu label",
  ])("refuses native New Chat ancestry: %s", async (change) => {
    const f = fixture("codex-draft");
    f.setImageChange(0);
    f.setMutate((s) => {
      if (s.snapshot_id !== "s2") return;
      if (change === "wrong File menu") {
        s.elements[2].label = "Edit";
        s.elements[2].title = "Edit";
      }
      if (change === "missing parent") s.elements[0].parent_index = 99999;
      if (change === "duplicate index")
        s.elements.push({ ...s.elements[1], element_token: "s2:99" });
      if (change === "cycle")
        s.elements[1].parent_index = s.elements[0].element_index;
      if (change === "missing root") s.elements.pop();
      if (change === "wrong container role") s.elements[1].role = "AXGroup";
      if (change === "invented menu label")
        s.elements[1].label = "Unqualified submenu";
    });
    const error = await f.run().catch((e) => e);
    expect(error).toBeInstanceOf(QualifiedNativeMenuError);
    expect(error.diagnostics.ancestryInvalid).toBe(true);
    expect(f.port.clickElement).not.toHaveBeenCalled();
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
  });
  it("retains every non-index ancestor semantic attribute and emits only fixed changed keys", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.snapshot_id === "s2") {
        s.elements[2].selected = true;
        s.elements[2]["private-surface-key"] = "private content";
      }
    });
    const error = await f.run().catch((e) => e);
    expect(error).toBeInstanceOf(QualifiedNativeMenuError);
    expect(error.diagnostics).toEqual({
      ancestryInvalid: false,
      ambiguousControl: false,
      changedKeys: ["otherAttribute", "selected"],
    });
    expect(JSON.stringify(error.diagnostics)).not.toContain("private");
    expect(f.port.clickElement).not.toHaveBeenCalled();
  });
  it("does not relax enumeration identity for coordinate actions", async () => {
    const f = fixture();
    f.setMutate((s) => {
      s.elements[0].element_index = s.snapshot_id === "s1" ? 1 : 2;
      s.elements[0].parent_index = 0;
    });
    await expect(f.run()).rejects.toThrow("absent or ambiguous");
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
  });
  it("rejects duplicate native New Chat even when screenshot bytes stayed unchanged", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.snapshot_id === "s2")
        s.elements.push({
          ...s.elements[0],
          enabled: false,
          element_token: "s2:1",
        });
    });
    await expect(f.run()).rejects.toThrow("changed before dispatch");
    expect(f.port.clickElement).not.toHaveBeenCalled();
  });
  it("requires enabled true on the original native menu", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      delete s.elements[0].enabled;
    });
    await expect(f.run()).rejects.toThrow("not enabled");
    expect(f.port.clickElement).not.toHaveBeenCalled();
  });
  it("still refuses changed screenshot pixels for the Codex coordinate draft", async () => {
    const f = fixture("codex-draft");
    f.setImageChange(1);
    await expect(f.run()).rejects.toThrow("screenshot changed");
    expect(f.port.clickElement).toHaveBeenCalledTimes(1);
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    expect(f.receipts.map((r) => r.state)).toEqual(["verified", "verified"]);
  });
  it("rejects changed pixels after corroboration without an input retry", async () => {
    const f = fixture();
    f.setImageChange();
    await expect(f.run()).rejects.toThrow("screenshot changed");
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
  });
  it.each([
    [
      "wrong pid",
      (s: any) => {
        s.pid = 101;
      },
    ],
    [
      "wrong window",
      (s: any) => {
        s.window_id = 201;
      },
    ],
    [
      "degraded",
      (s: any) => {
        s.degraded = true;
      },
    ],
    [
      "truncated",
      (s: any) => {
        s.truncated = true;
      },
    ],
    [
      "invalid frame",
      (s: any) => {
        s.screenshot_frame_valid = false;
      },
    ],
    [
      "spoofed screenshot geometry",
      (s: any) => {
        s.elements[0].screenshot_frame.x++;
      },
    ],
    [
      "out of bounds",
      (s: any) => {
        s.elements[0].frame.x = 799;
        s.elements[0].screenshot_frame.x = 799;
      },
    ],
    [
      "one pixel control",
      (s: any) => {
        s.elements[0].frame.h = 1;
        s.elements[0].screenshot_frame.h = 1;
      },
    ],
    [
      "missing geometry",
      (s: any) => {
        delete s.elements[0].screenshot_frame;
      },
    ],
    [
      "ambiguous contact",
      (s: any) => {
        s.elements.push({ ...s.elements[0], element_token: "another" });
      },
    ],
    [
      "different contact",
      (s: any) => {
        s.elements[0].label = "Other Contact, preview";
      },
    ],
    [
      "send control",
      (s: any) => {
        s.elements[0].role = "AXButton";
      },
    ],
  ])("blocks %s", async (_name, mutate) => {
    const f = fixture();
    f.setMutate(mutate as (s: any) => void);
    await expect(f.run()).rejects.toThrow();
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
  });
  it("keeps independently verified launch resolved when workflow capture is truncated", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      s.truncated = true;
    });
    const error = await f.run().catch((e) => e);
    expect(error).toBeInstanceOf(QualifiedBackgroundObservationError);
    expect(error.flags.truncated).toBe(true);
    expect(
      Object.values(error.flags).every((v) => typeof v === "boolean"),
    ).toBe(true);
    expect(f.receipts).toEqual([{ id: "receipt-0", state: "verified" }]);
    expect(f.port.clickElement).not.toHaveBeenCalled();
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
  });
  it("keeps launch resolved if the read-only SDK observation fails", async () => {
    const f = fixture();
    vi.mocked(f.port.observe).mockRejectedValue(Error("Capture unavailable."));
    await expect(f.run()).rejects.toThrow("Capture unavailable");
    expect(f.receipts[0]!.state).toBe("verified");
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
  });
  it.each(["pid", "bundle", "window"])(
    "requires exact independently bound launch candidate %s before resolving launch",
    async (mismatch) => {
      const f = fixture();
      vi.mocked(f.port.launchQualifiedApp).mockResolvedValue({
        ...good,
        launched: {
          pid: mismatch === "pid" ? 101 : 100,
          bundleId:
            mismatch === "bundle" ? "com.example.Other" : f.scope.bundleId,
          windowIds: [mismatch === "window" ? "201" : "200"],
        },
      });
      await expect(f.run()).rejects.toThrow("binding changed");
      expect(f.receipts[0]!.state).toBe("returned");
      expect(f.observe).not.toHaveBeenCalled();
    },
  );
  it("exports only fixed boolean failure diagnostics, without native content or data", async () => {
    const f = fixture();
    const raw = await f.observe();
    const flags = summarizeBackgroundObservation(raw, {
      pid: 100,
      windowId: "200",
      capturedAt: 1000,
      now: 1000,
    });
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
    const stale = summarizeBackgroundObservation(raw, {
      pid: 101,
      windowId: "201",
      capturedAt: 1000,
      now: 6000,
      snapshotAlreadySeen: true,
    });
    expect(stale).toMatchObject({
      identityMismatch: true,
      staleFrame: true,
      repeatedSnapshot: true,
    });
    expect(JSON.stringify(stale)).not.toContain("Test Contact");
    expect(JSON.stringify(stale)).not.toContain(raw.images[0]!.dataBase64);
    expect(
      summarizeBackgroundObservation(
        { ...raw, structuredJson: "{" },
        { pid: 100, windowId: "200", capturedAt: 1000, now: 1000 },
      ).malformedStructure,
    ).toBe(true);
    expect(
      summarizeBackgroundObservation(
        { ...raw, structuredJson: "x".repeat(4 * 1024 * 1024 + 1) },
        { pid: 100, windowId: "200", capturedAt: 1000, now: 1000 },
      ).structuredOversized,
    ).toBe(true);
  });
  it.each(["off-Space target", "ambiguous input window"])(
    "preserves verified launch when input binding refuses %s",
    async (reason) => {
      const f = fixture("codex-draft");
      vi.mocked(f.host.bindFreshTarget).mockRejectedValue(Error(reason));
      await expect(f.run()).rejects.toThrow(reason);
      expect(f.host.verifyLaunchedApplication).toHaveBeenCalledTimes(1);
      expect(f.receipts.map((r) => r.state)).toEqual(["verified"]);
      expect(f.observe).not.toHaveBeenCalled();
      expect(f.port.clickElement).not.toHaveBeenCalled();
      expect(f.port.typePixelDraft).not.toHaveBeenCalled();
    },
  );
  it("retains unresolved launch if the independent signed-app witness fails", async () => {
    const f = fixture();
    vi.mocked(f.host.verifyLaunchedApplication).mockRejectedValue(
      Error("Signed application witness failed."),
    );
    await expect(f.run()).rejects.toThrow("witness failed");
    expect(f.receipts.map((r) => r.state)).toEqual(["returned"]);
    expect(f.host.bindFreshTarget).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
  });
  it("checks live authority after launch witness before resolving or binding", async () => {
    const f = fixture();
    vi.mocked(f.host.verifyLaunchedApplication).mockImplementation(async () => {
      f.setLive(false);
    });
    await expect(f.run()).rejects.toThrow("authority expired");
    expect(f.receipts.map((r) => r.state)).toEqual(["returned"]);
    expect(f.host.bindFreshTarget).not.toHaveBeenCalled();
  });
  it("rejects an app version without its exact qualification", async () => {
    const f = fixture();
    vi.mocked(f.host.bindFreshTarget).mockResolvedValue({
      scope: f.scope,
      appVersion: "new-version",
    });
    await expect(f.run()).rejects.toThrow("binding changed");
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.receipts[0]!.state).toBe("verified");
  });
  it("rejects fresh process lifetime changes after visual corroboration", async () => {
    const f = fixture();
    let i = 0;
    vi.mocked(f.host.bindFreshTarget).mockImplementation(async () => ({
      scope: {
        ...f.scope,
        processStartIdentity: ++i === 1 ? "lifetime-1" : "lifetime-2",
      },
      appVersion: "1.0",
    }));
    await expect(f.run()).rejects.toThrow("binding changed");
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
  });
  it("rejects repeated snapshots after action and preserves returned receipt", async () => {
    const f = fixture();
    f.setMutate((s) => {
      s.snapshot_id = "replayed";
    });
    await expect(f.run()).rejects.toThrow("unproven");
    expect(f.port.clickQualifiedPoint).not.toHaveBeenCalled();
  });
  it("unknown action cannot be verified or repeated", async () => {
    const f = fixture();
    vi.mocked(f.port.clickQualifiedPoint).mockResolvedValue({
      ...good,
      dispatch: "unknown",
      effect: "unknown",
      code: "unknown",
    });
    await expect(f.run()).rejects.toThrow("unverified");
    expect(f.receipts[1]!.state).toBe("unknown");
    expect(f.disarm).toHaveBeenCalled();
    await expect(f.run()).rejects.toThrow("replay");
    expect(f.port.clickQualifiedPoint).toHaveBeenCalledTimes(1);
  });
  it("failed postcondition leaves returned receipt unresolved", async () => {
    const f = fixture();
    vi.mocked(f.planner.verify).mockResolvedValue({
      verified: false,
      summary: "Unclear.",
    });
    await expect(f.run()).rejects.toThrow("verification");
    expect(f.receipts[1]!.state).toBe("returned");
  });
  it("refuses a nonempty existing draft", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      if (s.elements[0].role === "AXTextArea")
        s.elements[0].value = "existing draft";
    });
    await expect(f.run()).rejects.toThrow("absent or ambiguous");
    expect(f.port.typePixelDraft).not.toHaveBeenCalled();
  });
  it("cannot use sidebar New Chat or token with no native AXPress", async () => {
    const f = fixture("codex-draft");
    f.setMutate((s) => {
      s.elements[0].role = "AXButton";
    });
    await expect(f.run()).rejects.toThrow("absent or ambiguous");
    expect(f.port.clickElement).not.toHaveBeenCalled();
  });
  it("Stop aborts admission while close delegates exact-session cleanup", async () => {
    const f = fixture();
    f.worker.stop();
    await expect(f.run()).rejects.toThrow();
    expect(f.port.launchQualifiedApp).not.toHaveBeenCalled();
    expect(await f.worker.close()).toEqual({ quiescence: "known" });
  });
  it("final lease admission matches exact target, action, identity, and time", async () => {
    const f = fixture();
    await f.run();
    const g = f.grants[0]!;
    const scope = {
      driverGeneration: g.binding.driverGeneration,
      operation: "click" as const,
      target: g.binding,
      actionId: g.actionId,
      action: g.action,
    };
    expect(admitQualifiedGrant(g, scope, 1000)).toBe(true);
    expect(
      admitQualifiedGrant(g, { ...scope, actionId: "foreign" }, 1000),
    ).toBe(false);
    expect(
      admitQualifiedGrant(
        g,
        { ...scope, target: { ...g.binding, pid: 101 } },
        1000,
      ),
    ).toBe(false);
    expect(
      admitQualifiedGrant(
        g,
        {
          ...scope,
          action: {
            ...g.action,
            geometry: {
              ...g.action.geometry!,
              bounds: { ...g.action.geometry!.bounds, x: 41 },
            },
          },
        },
        1000,
      ),
    ).toBe(false);
    expect(admitQualifiedGrant(g, scope, 6001)).toBe(false);
    expect(admitQualifiedGrant(g, scope, g.expiresAt)).toBe(false);
    expect(admitQualifiedGrant(g, scope, 999)).toBe(false);
  });
});
