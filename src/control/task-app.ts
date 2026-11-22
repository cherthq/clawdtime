import { Hono } from "hono";
import { buildTaskBrief } from "../attention/task-ledger.js";
import { bodyLimit } from "hono/body-limit";
import { equal, DomainError } from "../storage/security.js";
import { z, ZodError } from "zod";
import type { TaskCommand } from "../contracts.js";
import type { TaskService } from "./task-service.js";
import type { TaskEngine } from "./task-engine.js";
import type { TaskPresentationService } from "./task-presentation-service.js";
import type { TaskVoiceService } from "./task-voice-service.js";
import type { TaskDesktopService } from "./task-desktop-service.js";
import type { TaskDesktopCalls } from "./task-desktop-calls.js";
import type {
  DesktopExecutionSnapshot,
  DesktopExecutor,
} from "./desktop-executor.js";
import type { BackgroundRuntime } from "./background-runtime.js";
import type { BundledCuaRuntime } from "./bundled-cua-runtime.js";
import type { LineRuntime } from "./line-runtime.js";
import type { PhoneDesktop } from "./phone-desktop.js";
import { mountPhoneDesktop } from "./phone-desktop-routes.js";
import type { ProactiveService } from "./proactive-service.js";
import { proactivePolicySchema } from "../attention/proactive-policy.js";
import {
  mountProactiveLine,
  type ProactiveLineSessions,
} from "./proactive-line.js";
import type { PhoneTurnContext } from "../phone-desktop-contracts.js";

/**
 * Computer use as the panel routes see it. The hands that see the screen and
 * send input live in the panel: it asks for the next command and posts what
 * happened. A service where no worker runs still answers, with nothing to do.
 */
export interface ComputerPort {
  /** The command that waits for the hands, when its number is after `after`. */
  next(after: number): unknown;
  /** The result of one command. False when no command waits for it. */
  result(raw: unknown): boolean;
  /** Whether computer use is on, what it does now and what it asks. */
  status(): unknown;
  /** Transient presentation metadata, separate from observations and action receipts. */
  present?(raw: unknown): boolean;
  presentation?(): unknown;
  /** Stop. Absent where no worker runs. */
  stop?(): DesktopExecutionSnapshot;
}
const handsAfterSchema = z
  .string()
  .regex(/^[0-9]{1,15}$/)
  .transform(Number);

/**
 * The agent board as the panel routes see it. The board is built in a separate
 * process; these calls only read its latest snapshot and bring a terminal forward.
 */
export interface AgentBoardPort {
  /** The latest snapshot, or null when none is fresh. */
  snapshot(): unknown | null;
  focus(id: string): Promise<{ ok: boolean; precision: string }>;
  /** The requests of agents that wait for the person's answer. */
  decisions(): unknown;
  answer(input: {
    id: string;
    decision: "allow" | "deny" | "answer";
    text?: string | null;
    remember?: boolean;
  }): boolean | Promise<boolean>;
  setAway(away: boolean): void;
  send(
    id: string,
    text: string,
    enter: boolean,
  ): Promise<{ ok: boolean; route: string }>;
  /** The conversation with ClawdTime itself. */
  chat(): unknown;
  say(
    text: string,
    via?: "chat" | "voice",
    context?: PhoneTurnContext,
  ): Promise<unknown>;
  hear(recording: string): Promise<unknown>;
  setMemory(enabled: boolean): void;
  /** What the watcher found on the sessions. */
  incidents(): unknown;
  dismissIncident(id: string): boolean;
}
const incidentDismissSchema = z
  .object({ id: z.string().regex(/^[0-9a-f]{12}$/) })
  .strict();
const memorySchema = z.object({ enabled: z.boolean() }).strict();
const chatSchema = z.object({ text: z.string().min(1).max(8000) }).strict();
const voiceSchema = z
  .object({ recording: z.string().regex(/^[A-Za-z0-9_-]{1,60}\.(wav|m4a)$/) })
  .strict();
const decisionAnswerSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{16}$/),
    decision: z.enum(["allow", "deny", "answer"]),
    text: z.string().max(600).nullable().optional(),
    remember: z.boolean().optional(),
  })
  .strict();
const awaySchema = z.object({ away: z.boolean() }).strict();
const agentSendSchema = z
  .object({
    id: z.string().regex(/^[0-9a-z][0-9a-z_-]{1,63}$/),
    text: z.string().min(1).max(4000),
    enter: z.boolean().optional(),
  })
  .strict();
const agentFocusSchema = z
  .object({ id: z.string().regex(/^[0-9a-z][0-9a-z_-]{1,63}$/) })
  .strict();

export function createTaskApp(
  service: TaskService,
  operatorToken: string,
  engine?: TaskEngine,
  voice?: TaskVoiceService,
  presentation?: TaskPresentationService,
  handset?: { taskId: string; voiceId: string; presentationId?: string },
  desktop?: TaskDesktopService,
  calls?: TaskDesktopCalls,
  agents?: AgentBoardPort,
  executor?: DesktopExecutor | BundledCuaRuntime | BackgroundRuntime,
  computer?: ComputerPort,
  lineRuntime?: LineRuntime,
  phone?: { scope: PhoneDesktop; instanceId: string },
  proactive?: {
    service: ProactiveService;
    enroll(input: unknown): void;
    line?: ProactiveLineSessions;
    status?(): unknown;
  },
) {
  if (operatorToken.length < 32)
    throw new Error("Protected operator token required.");
  const app = new Hono();
  const bearer = (value?: string) =>
    value?.startsWith("Bearer ") ? value.slice(7) : "";
  const limit = bodyLimit({ maxSize: 32768 });
  // A result of the hands can hold a picture of the screen. Only that route
  // takes a body of up to 6 MB, and the panel credential is checked before any
  // of it is read.
  const pictureLimit = bodyLimit({ maxSize: 6 * 1024 * 1024 });
  app.use("*", (c, next) => {
    // The credential of the phone runtime comes before everything else of a
    // command: a request with no token or a wrong one gets the same refusal
    // whatever its body is, and no part of the body is read, measured or
    // parsed.
    if (lineRuntime && c.req.path === "/line/command")
      lineRuntime.authorize(bearer(c.req.header("authorization")));
    if (
      desktop &&
      computer &&
      c.req.method === "POST" &&
      c.req.path === "/desktop/hands/result"
    ) {
      desktop.authorizePanel(bearer(c.req.header("authorization")));
      return pictureLimit(c, next);
    }
    return limit(c, next);
  });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (handset) {
      // The call process serves one admitted voice, not a general task launcher.
      const base = `/tasks/${encodeURIComponent(handset.taskId)}`;
      const voiceBase = `${base}/voice/${encodeURIComponent(handset.voiceId)}`;
      const allowed = new Set([
        "GET /health",
        ...(desktop ? ["GET /desktop/state", "POST /desktop/operations"] : []),
        `GET ${voiceBase}/context`,
        ...[
          "bind",
          "utterances",
          "instructions",
          "accept",
          "end",
          "presentation/opening",
          "presentation/show",
          "presentation/stop",
          "presentation/retire",
        ].map((path) => `POST ${voiceBase}/${path}`),
        ...(handset.presentationId
          ? [
              `GET ${base}/presentations/${encodeURIComponent(handset.presentationId)}/authority`,
            ]
          : []),
      ]);
      if (
        !allowed.has(`${c.req.method} ${c.req.path}`) &&
        !(
          desktop &&
          c.req.method === "GET" &&
          /^\/desktop\/operations\/[A-Za-z0-9_:-]{1,160}$/.test(c.req.path)
        )
      )
        return c.json({ error: "Route outside this handset session." }, 403);
    }
    // A local developer API, not a browser-facing credential or CORS surface.
    if (c.req.header("origin"))
      return c.json({ error: "Browser origins are not admitted." }, 403);
    if (
      c.req.method === "POST" &&
      !c.req.header("content-type")?.startsWith("application/json")
    )
      return c.json({ error: "JSON required." }, 415);
    await next();
  });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof DomainError
            ? error.message
            : error instanceof ZodError
              ? "Invalid task input."
              : "Task request refused.",
      },
      error instanceof DomainError ? (error.status as 400) : 400,
    ),
  );
  app.get("/health", (c) =>
    c.json({
      mode: service.options.simulation ? "simulation" : "standby",
      liveDispatch: false,
      presentation: !!presentation,
      control: false,
    }),
  );
  if (proactive) {
    if (proactive.line) mountProactiveLine(app, proactive.line);
    app.use("/operator/proactive/*", async (c, next) => {
      if (!equal(bearer(c.req.header("authorization")), operatorToken))
        return c.json({ error: "Operator credential required." }, 401);
      await next();
    });
    app.get("/operator/proactive/doctor", (c) =>
      c.json({
        ...proactive.service.doctor(),
        installation: proactive.status?.(),
      }),
    );
    app.get("/operator/proactive/intents", (c) =>
      c.json({
        intents: proactive.service.coordinator.list().map((r) => ({
          id: r.id,
          source: r.source,
          channel: r.channel,
          state: r.state,
          reason: r.reason,
          attemptId: r.attemptId,
        })),
      }),
    );
    app.post("/operator/proactive/policies", async (c) => {
      const policy = proactive.service.coordinator.authority.register(
        proactivePolicySchema.parse(await c.req.json()),
      );
      return c.json({ id: policy.id, revision: policy.revision }, 201);
    });
    app.post("/operator/proactive/policies/:id/revoke", (c) => {
      const policy = proactive.service.coordinator.authority.revoke(
        c.req.param("id"),
      );
      return c.json({ id: policy.id, revoked: true });
    });
    app.post("/operator/proactive/enroll", async (c) => {
      proactive.enroll(await c.req.json());
      return c.json({ enrolled: true });
    });
    app.post("/operator/proactive/intents/:id/stop", async (c) => {
      const result = await proactive.service.stop(c.req.param("id"));
      return c.json({ id: result.id, state: result.state });
    });
  }
  if (phone && desktop && agents)
    mountPhoneDesktop(app, {
      ...phone,
      authorize: (token) => desktop.authorizePanel(token),
      say: (text, via, context) => agents.say(text, via, context),
    });
  if (lineRuntime) {
    app.get("/line/frame", async (c) => {
      const frame = await lineRuntime.preview(
        bearer(c.req.header("authorization")),
        c.req.query("callId") ?? "",
      );
      if (
        !frame ||
        !frame.valid() ||
        Date.now() >= frame.expiresAt ||
        !frame.layout.visible
      )
        return c.body(null, 204, { "cache-control": "no-store" });
      return c.body(Buffer.from(frame.rgba), 200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-clawdtime-frame": JSON.stringify({
          width: frame.width,
          height: frame.height,
          frameId: frame.frameId,
          capturedAt: frame.capturedAt,
          expiresAt: frame.expiresAt,
          layout: frame.layout,
        }),
      });
    });
    app.post("/line/command", async (c) => {
      // Once more here, so the order does not rest on the middleware alone:
      // the token first, then the body.
      const credential = bearer(c.req.header("authorization"));
      lineRuntime.authorize(credential);
      return c.json(await lineRuntime.command(credential, await c.req.json()));
    });
  }
  if (desktop) {
    const credential = (c: any) => bearer(c.req.header("authorization"));
    // One stop route for whatever does the computer work here: the connection
    // to an existing chat, or else the app-owned worker.
    const stop = executor
      ? () => executor.stop()
      : computer?.stop
        ? () => computer.stop!()
        : undefined;
    if (stop)
      app.post("/desktop/execution/stop", (c) => {
        desktop.authorizePanel(credential(c));
        return c.json({ execution: stop() });
      });
    if (executor) {
      if ("command" in executor)
        app.post("/executor/command", async (c) =>
          c.json(executor.command(credential(c), await c.req.json())),
        );
      if ("decision" in executor)
        app.post("/desktop/execution/decision", async (c) => {
          desktop.authorizePanel(credential(c));
          const input = z
            .object({
              actionId: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
              approve: z.boolean(),
            })
            .strict()
            .parse(await c.req.json());
          return c.json({
            execution: executor.decision(input.actionId, input.approve),
          });
        });
    }
    if (computer) {
      // The panel's hands: the next command, and what came of it. The same
      // command is served until its result arrives.
      app.get("/desktop/hands/next", (c) => {
        desktop.authorizePanel(credential(c));
        return c.json(
          computer.next(handsAfterSchema.parse(c.req.query("after") ?? "0")),
        );
      });
      app.post("/desktop/hands/result", async (c) => {
        desktop.authorizePanel(credential(c));
        return c.json({ ok: computer.result(await c.req.json()) });
      });
      app.post("/desktop/hands/presentation", async (c) => {
        desktop.authorizePanel(credential(c));
        return c.json({ ok: computer.present?.(await c.req.json()) ?? false });
      });
      app.get("/desktop/presentation", (c) => {
        desktop.authorizePanel(credential(c));
        return c.json(computer.presentation?.() ?? { version: 1, event: null });
      });
      app.get("/desktop/computer", (c) => {
        desktop.authorizePanel(credential(c));
        return c.json(computer.status());
      });
    }
    app.get("/desktop/state", (c) => c.json(desktop.snapshot(credential(c))));
    app.get("/desktop/operations/:eventId", (c) =>
      c.json(desktop.operation(credential(c), c.req.param("eventId"))),
    );
    app.post("/desktop/operations", async (c) =>
      c.json(await desktop.submit(credential(c), await c.req.json())),
    );
    if (agents) {
      app.get("/desktop/agents", (c) => {
        desktop.authorizePanel(credential(c));
        const board = agents.snapshot();
        if (!board) throw new DomainError(503, "Agent board unavailable.");
        return c.json(board);
      });
      // Focus brings a terminal forward. It sends nothing to the session.
      app.post("/desktop/agents/focus", async (c) => {
        desktop.authorizePanel(credential(c));
        const { id } = agentFocusSchema.parse(await c.req.json());
        const { ok, precision } = await agents.focus(id);
        return c.json({ ok, precision });
      });
      // What agents ask the person, and the person's answers. Reading this also
      // tells the agents' hooks that someone is here to answer.
      app.get("/desktop/decisions", (c) => {
        desktop.authorizePanel(credential(c));
        return c.json(agents.decisions());
      });
      app.post("/desktop/decisions/answer", async (c) => {
        desktop.authorizePanel(credential(c));
        // An agent on a remote Mac gets its answer over ssh, so this can take a moment.
        return c.json({
          ok: await agents.answer(
            decisionAnswerSchema.parse(await c.req.json()),
          ),
        });
      });
      app.post("/desktop/decisions/away", async (c) => {
        desktop.authorizePanel(credential(c));
        const { away } = awaySchema.parse(await c.req.json());
        agents.setAway(away);
        return c.json({ away });
      });
      // The person talks to ClawdTime: typed here, or one recording at a time.
      app.get("/desktop/chat", (c) => {
        desktop.authorizePanel(credential(c));
        return c.json(agents.chat());
      });
      app.post("/desktop/chat", async (c) => {
        desktop.authorizePanel(credential(c));
        const { text } = chatSchema.parse(await c.req.json());
        return c.json({ reply: await agents.say(text) });
      });
      app.post("/desktop/voice", async (c) => {
        desktop.authorizePanel(credential(c));
        const { recording } = voiceSchema.parse(await c.req.json());
        return c.json(await agents.hear(recording));
      });
      // Memory is off until the person turns it on, here or with `clawdtime memory on`.
      app.post("/desktop/memory", async (c) => {
        desktop.authorizePanel(credential(c));
        const { enabled } = memorySchema.parse(await c.req.json());
        agents.setMemory(enabled);
        return c.json({ enabled });
      });
      // What the watcher found: a long wait, a stall, a bad end, finished work.
      app.get("/desktop/incidents", (c) => {
        desktop.authorizePanel(credential(c));
        return c.json(agents.incidents());
      });
      app.post("/desktop/incidents/dismiss", async (c) => {
        desktop.authorizePanel(credential(c));
        const { id } = incidentDismissSchema.parse(await c.req.json());
        return c.json({ ok: agents.dismissIncident(id) });
      });
      // Types the person's own words into one session's terminal.
      app.post("/desktop/agents/send", async (c) => {
        desktop.authorizePanel(credential(c));
        const { id, text, enter } = agentSendSchema.parse(await c.req.json());
        const { ok, route } = await agents.send(id, text, enter !== false);
        return c.json({ ok, route });
      });
    }
  }
  if (calls) {
    app.use("/operator/desktop-calls", async (c, next) => {
      if (!equal(bearer(c.req.header("authorization")), operatorToken))
        return c.json({ error: "Operator authorization required." }, 401);
      await next();
    });
    app.get("/operator/desktop-calls", (c) => c.json(calls.status()));
    app.post("/operator/desktop-calls", async (c) =>
      c.json(calls.request(await c.req.json()), 202),
    );
  }
  if (desktop?.reviews) {
    app.use("/operator/review-callbacks/*", async (c, next) => {
      if (!equal(bearer(c.req.header("authorization")), operatorToken))
        return c.json({ error: "Operator authorization required." }, 401);
      await next();
    });
    app.post("/operator/review-callbacks/:id/prepare", async (c) => {
      const result = desktop.reviews!.stage(
        c.req.param("id"),
        await c.req.json(),
      );
      void desktop.reviews!.pump();
      return c.json(result, 202);
    });
  }
  if (presentation) {
    const credential = (c: any) => bearer(c.req.header("authorization"));
    const path = "/tasks/:id/presentations/:presentationId";
    app.post("/tasks/:id/presentations", async (c) =>
      c.json(
        await presentation.prepare(
          credential(c),
          c.req.param("id"),
          await c.req.json(),
        ),
      ),
    );
    app.get(path, (c) =>
      c.json(
        presentation.status(
          credential(c),
          c.req.param("id"),
          c.req.param("presentationId"),
        ),
      ),
    );
    app.get(`${path}/authority`, (c) =>
      c.json(
        presentation.authority(
          credential(c),
          c.req.param("id"),
          c.req.param("presentationId"),
        ),
      ),
    );
    app.post(`${path}/scenes`, async (c) =>
      c.json(
        await presentation.show(
          credential(c),
          c.req.param("id"),
          c.req.param("presentationId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${path}/narrate`, async (c) =>
      c.json(
        await presentation.narrate(
          credential(c),
          c.req.param("id"),
          c.req.param("presentationId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${path}/stop`, async (c) =>
      c.json(
        await presentation.stop(
          credential(c),
          c.req.param("id"),
          c.req.param("presentationId"),
          await c.req.json(),
        ),
      ),
    );
  }
  if (voice) {
    const credential = (c: any) => bearer(c.req.header("authorization"));
    const voicePath = "/tasks/:id/voice/:voiceId";
    app.post(`${voicePath}/accept`, async (c) =>
      c.json(
        voice.accept(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${voicePath}/presentation/opening`, async (c) =>
      c.json(
        await voice.presentationOpening(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${voicePath}/presentation/show`, async (c) =>
      c.json(
        await voice.presentationShow(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${voicePath}/presentation/stop`, async (c) =>
      c.json(
        await voice.presentationStop(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${voicePath}/presentation/retire`, async (c) =>
      c.json(
        await voice.presentationRetire(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post("/tasks/:id/voice-sessions", async (c) =>
      c.json(voice.open(credential(c), c.req.param("id"), await c.req.json())),
    );
    app.get(`${voicePath}/context`, (c) =>
      c.json(
        voice.context(credential(c), c.req.param("id"), c.req.param("voiceId")),
      ),
    );
    app.post(`${voicePath}/bind`, async (c) =>
      c.json(
        voice.bind(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${voicePath}/utterances`, async (c) =>
      c.json(
        voice.utterance(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${voicePath}/instructions`, async (c) =>
      c.json(
        voice.instruction(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
    app.post(`${voicePath}/end`, async (c) =>
      c.json(
        voice.end(
          credential(c),
          c.req.param("id"),
          c.req.param("voiceId"),
          await c.req.json(),
        ),
      ),
    );
  }
  app.post("/sessions", async (c) => {
    if (!equal(bearer(c.req.header("authorization")), operatorToken))
      throw new DomainError(401, "Operator authorization required.");
    return c.json(service.register(await c.req.json()));
  });
  app.post("/sessions/:id/reauthorize", async (c) => {
    if (!equal(bearer(c.req.header("authorization")), operatorToken))
      throw new DomainError(401, "Operator authorization required.");
    return c.json(service.reauthorize(c.req.param("id"), await c.req.json()));
  });
  app.get("/tasks/:id/readiness", (c) =>
    c.json(
      service.readiness(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
      ),
    ),
  );
  app.post("/tasks", async (c) =>
    c.json(
      service.create(bearer(c.req.header("authorization")), await c.req.json()),
    ),
  );
  app.post("/tasks/:id/run", (c) => {
    const session = service.authenticate(bearer(c.req.header("authorization")));
    if (!engine) throw new DomainError(409, "No real worker is configured.");
    return c.json(engine.start(session.id, c.req.param("id")));
  });
  app.get("/tasks/:id/brief", (c) => {
    const session = service.authenticate(bearer(c.req.header("authorization")));
    return c.json(
      buildTaskBrief(service.ledger.get(session.id, c.req.param("id"))),
    );
  });
  app.get("/tasks/:id", (c) => {
    const session = service.authenticate(bearer(c.req.header("authorization")));
    return c.json(service.ledger.get(session.id, c.req.param("id")));
  });
  app.post("/tasks/:id/commands", async (c) => {
    const raw = bearer(c.req.header("authorization"));
    const command = await c.req.json<TaskCommand>();
    const mutation = service.command(raw, c.req.param("id"), command);
    if (engine && !mutation.replayed) {
      if (command.action === "cancel") engine.cancel(mutation.task.id);
      if (command.action === "decide")
        mutation.task = engine.start(mutation.task.sessionId, mutation.task.id);
    }
    return c.json(mutation);
  });
  return app;
}
