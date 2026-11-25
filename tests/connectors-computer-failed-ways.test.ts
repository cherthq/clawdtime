import { describe, expect, it } from "vitest";
import { aimOf } from "../connectors/computer/failed-ways.js";
import { element, observation } from "./connectors-computer-fixture.js";

const seen = observation([
  element(1, { title: "Export", enabled: false }),
  element(2, { title: "Search", role: "AXTextField" }),
  element(3, { title: "Code 482913", role: "AXStaticText" }),
]);

describe("the element of a step", () => {
  it("keeps the name that the journal keeps, with the role of the element of the look", () => {
    expect(
      aimOf({ kind: "click_element", element: 1 }, "Export", seen),
    ).toEqual({ target: "Export", role: "AXButton" });
    expect(
      aimOf({ kind: "type", text: "milk", element: 2 }, "Search", seen),
    ).toEqual({ target: "Search", role: "AXTextField" });
  });

  it("names the element of the look when the checks refused the action before they named it", () => {
    expect(aimOf({ kind: "click_element", element: 1 }, "", seen)).toEqual({
      target: "Export",
      role: "AXButton",
    });
    // An element that is not in the look names nothing.
    expect(aimOf({ kind: "click_element", element: 40 }, "", seen)).toEqual({});
  });

  it("gives no role when the look does not hold the element of that name", () => {
    expect(aimOf({ kind: "click_at", x: 10, y: 20 }, "Layers", seen)).toEqual({
      target: "Layers",
    });
    expect(
      aimOf({ kind: "click_element", element: 2 }, "Export", seen),
    ).toEqual({ target: "Export" });
    expect(aimOf({ kind: "key", combo: "cmd+s" }, "cmd+s", null)).toEqual({
      target: "cmd+s",
    });
  });

  it("never holds typed text, and leaves out a name that looks like a secret", () => {
    const typed = aimOf(
      { kind: "type", text: "hunter22 is my password", element: 2 },
      "Search",
      seen,
    );
    expect(JSON.stringify(typed)).not.toContain("hunter22");
    expect(aimOf({ kind: "type", text: "x" }, "", seen)).toEqual({});
    expect(aimOf({ kind: "click_element", element: 3 }, "", seen)).toEqual({});
    expect(
      aimOf({ kind: "click_at", x: 1, y: 1 }, "password: hunter22", seen),
    ).toEqual({});
  });

  it("cuts the name to 60 characters on one line", () => {
    const aim = aimOf(
      { kind: "click_at", x: 1, y: 1 },
      `Line one\nLine two ${"y".repeat(200)}`,
      null,
    );
    expect(aim.target).toBe(`Line one Line two ${"y".repeat(42)}`);
  });
});
