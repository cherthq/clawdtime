import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { equal, DomainError } from "../storage/security.js";
import { ZodError } from "zod";
import type { TaskCommand } from "../contracts.js";
import type { TaskService } from "./task-service.js";
import type { TaskEngine } from "./task-engine.js";

export function createTaskApp(
  service: TaskService,
  operatorToken: string,
  engine?: TaskEngine,
) {
  if (operatorToken.length < 32)
    throw new Error("Protected operator token required.");
  const app = new Hono();
  const bearer = (value?: string) =>
    value?.startsWith("Bearer ") ? value.slice(7) : "";
  app.use("*", bodyLimit({ maxSize: 32768 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
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
      presentation: false,
      control: false,
    }),
  );
  app.post("/sessions", async (c) => {
    if (!equal(bearer(c.req.header("authorization")), operatorToken))
      throw new DomainError(401, "Operator authorization required.");
    return c.json(service.register(await c.req.json()));
  });
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
