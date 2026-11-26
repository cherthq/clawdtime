import { z } from "zod";
import { jsonRequest } from "./native-messages.js";
import {
  NativeTaskAudioCalls,
  type TaskAudioCredentials,
} from "./task-audio.js";
import { hash } from "../storage/security.js";
import type { SharedCallbackOwnership } from "../shared-number-contracts.js";

export class SharedProviderAPI {
  constructor(
    private config: {
      callsOrigin: string;
      projectId: string;
      projectKey: string;
      lineId: string;
      integrationId: string;
      endpoint: string;
      controlToken(): string;
      transportReady(
        line: unknown,
        worker: unknown,
        now: number,
      ): { audioReady: boolean; videoReady: boolean };
    },
    private request: typeof fetch = fetch,
  ) {
    const url = new URL(config.callsOrigin);
    if (
      url.protocol !== "https:" ||
      url.origin !== config.callsOrigin ||
      url.username ||
      url.password
    )
      throw Error("shared_provider_origin");
    const endpoint = new URL(config.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.search
    )
      throw Error("shared_provider_endpoint");
    z.uuid().parse(config.lineId);
    z.uuid().parse(config.projectId);
    z.uuid().parse(config.integrationId);
  }
  private async get(path: string, control = false) {
    return (
      await jsonRequest(
        this.config.callsOrigin + path,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${control ? this.config.controlToken() : this.config.projectKey}`,
            "X-Chert-Project-Id": this.config.projectId,
          },
        },
        this.request,
        5000,
      )
    ).data;
  }
  private async inventory(kind: string) {
    const items: any[] = [];
    for (let offset = 0; offset < 2000;) {
      const page = z
        .object({
          items: z.array(z.any()).max(100),
          total: z.number().int().nonnegative(),
          offset: z.literal(offset),
          limit: z.literal(100),
        })
        .parse(await this.get(`/api/v1/${kind}?limit=100&offset=${offset}`));
      items.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total) return items;
      if (!page.items.length) break;
    }
    throw Error("shared_provider_inventory_unavailable");
  }
  async ready(idle = true) {
    try {
      const [lines, workers, integrations, bindings] = await Promise.all([
        this.inventory("lines"),
        this.inventory("workers"),
        this.get("/api/v1/integrations"),
        this.get("/api/v1/connectors", true),
      ]);
      const line = lines.find((l) => l.id === this.config.lineId),
        worker = workers.find((w) => w.id === line?.worker_id);
      const integration = z
        .object({ items: z.array(z.any()).max(2000) })
        .parse(integrations)
        .items.find((i) => i.id === this.config.integrationId);
      if (
        !line ||
        !worker ||
        !integration ||
        integration.project_id !== this.config.projectId ||
        line.integration_id !== integration.id ||
        line.inbound_policy !== "customer_decides" ||
        line.default_assistant_id ||
        !integration.enabled ||
        !integration.signing_enabled ||
        integration.endpoint_url !== this.config.endpoint ||
        z
          .array(z.any())
          .parse(bindings)
          .some(
            (b) =>
              b.scope?.line_id === line.id &&
              (b.connected === true || b.state === "active"),
          )
      )
        return false;
      if (
        idle &&
        (line.current_call_id !== null ||
          line.worker_occupied !== false ||
          line.status !== "available")
      )
        return false;
      const ready = this.config.transportReady(line, worker, Date.now());
      return ready.audioReady && ready.videoReady;
    } catch {
      return false;
    }
  }
  async observe(providerCallId: string) {
    z.uuid().parse(providerCallId);
    const call = z
      .object({
        id: z.literal(providerCallId),
        line_id: z.literal(this.config.lineId),
      })
      .parse(await this.get(`/api/v1/calls/${providerCallId}`));
    const data = z
      .object({
        call_id: z.literal(call.id),
        events: z
          .array(
            z.object({ id: z.string(), type: z.string(), source: z.string() }),
          )
          .max(10000),
      })
      .parse(await this.get(`/api/v1/calls/${call.id}/events`));
    if (new Set(data.events.map((e) => e.id)).size !== data.events.length)
      throw Error("shared_provider_event_conflict");
    const events = new Set(
      data.events.filter((e) => e.source === "worker").map((e) => e.type),
    );
    return {
      answered: events.has("bridge_ready"),
      terminal: ["cleanup_complete", "ended", "failed", "rejected"].some((t) =>
        events.has(t),
      ),
      cleanupComplete: events.has("cleanup_complete"),
    };
  }
  dial(callback: SharedCallbackOwnership, credentials: TaskAudioCredentials) {
    if (callback.lineId !== this.config.lineId)
      throw Error("shared_provider_line_mismatch");
    const calls = new NativeTaskAudioCalls(
      { ...this.config, recipient: callback.scope.recipient },
      this.request,
    );
    return calls.createProactive(
      {
        attemptId: callback.id,
        lineId: callback.lineId,
        recipientHash: hash(callback.scope.recipient),
        agentIdentity: "shared-agent",
        channel: "phone_walkthrough",
      },
      credentials,
      callback.id,
    );
  }
}
