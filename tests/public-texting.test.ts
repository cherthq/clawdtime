import { describe, it, expect } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { createApp } from "../src/app.js";
import { publicPage } from "../src/public-page.js";

describe("public Messages entry point", () => {
  it.each([
    { simulation: false, dispatchEnabled: true, published: true },
    { simulation: false, dispatchEnabled: false, published: false },
    { simulation: true, dispatchEnabled: true, published: false },
  ])(
    "publishes only on an explicitly enabled live instance: %j",
    async (mode) => {
      const store = new Store();
      try {
        const service = new ClawdTime(store, new SimulationTransport());
        const control = new ControlCoordinator(store, new SimulatedDevice());
        const app = createApp(
          service,
          control,
          new HumanRouter(service, control),
          {
            origin: "https://fixture.example",
            publicTextNumber: "+15550000001",
            ...mode,
          },
        );
        const response = await app.request("/");
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(
          html.includes('href="sms:+15550000001?body=Hey%20ClawdTime"'),
        ).toBe(mode.published);
        expect(html.includes('href="#text-it" data-text-it')).toBe(
          !mode.published,
        );
        expect(html.includes('id="text-it" data-text-ready')).toBe(
          mode.published,
        );
        expect(store.effects()).toHaveLength(0);
        expect(store.all("pairing")).toHaveLength(0);
      } finally {
        store.close();
      }
    },
  );
  it("refuses non-number URLs rather than interpolating arbitrary HTML or destinations", () => {
    for (const value of [
      "javascript:alert(1)",
      '+1555" onclick="alert(1)',
      "person@example.com",
    ])
      expect(() =>
        publicPage('<a href="#text-it" data-text-it>Text</a>', value),
      ).toThrow();
  });
});
