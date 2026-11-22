import { z } from "zod";
import { ZOOM_ACTIONS } from "./zoom-settings.mjs";

/** The actual call tool wiring, separately testable without audio or a room.
 * Model arguments select bounded presentation actions, never the computer's
 * request text. All authority comes from the provider-bound response handle. */
export function makeCallerTools({
  tool,
  binding,
  ended,
  ask,
  showScreen,
  setZoom,
  zoomStatus,
  reshape,
  allowShape,
}) {
  const active = () => (ended() ? "The call has ended." : null);
  return [
    tool({
      name: "ask_clawdtime",
      description:
        "Ask the Mac supervisor to interpret and handle the caller's complete current request. Use for app/window/desktop navigation, computer work, status, sessions, approvals, and jobs. The original successful speech transcript is supplied automatically; do not paraphrase, split, or replace it. Use once per caller turn.",
      parameters: z.object({}).strict(),
      execute: async (_args, options) => {
        const closed = active();
        if (closed) return closed;
        const bound = binding.take(options, "computer");
        return bound.ok ? ask(bound.text) : bound.message;
      },
    }),
    tool({
      name: "stop_computer",
      description:
        "Immediately stop current computer work when the caller asks to stop or cancel it. This can only reduce control; it never starts another action.",
      parameters: z.object({}).strict(),
      execute: async () => {
        const closed = active();
        if (closed) return closed;
        binding.cancel();
        return ask("stop");
      },
    }),
    tool({
      name: "show_screen",
      description:
        "Show or hide the Mac screen on the call when the caller requests it. Interpret their intent, including negation. Showing requires the current caller turn; hiding only reduces sharing.",
      parameters: z.object({ on: z.boolean() }).strict(),
      execute: async ({ on }, options) => {
        const closed = active();
        if (closed) return closed;
        if (on) {
          const bound = binding.take(options, "sharing");
          if (!bound.ok) return bound.message;
        }
        return showScreen(on);
      },
    }),
    tool({
      name: "call_zoom",
      description:
        "Interpret the caller's request to change call-video zoom. overview keeps the whole screen visible until explicit resume. enable/disable change automatic zoom; enable alone never releases overview. Use only for the caller's requested action, never for quoted, negated or hypothetical instructions.",
      parameters: z.object({ action: z.enum(ZOOM_ACTIONS) }).strict(),
      execute: async ({ action }, options) => {
        const closed = active();
        if (closed) return closed;
        const bound = binding.take(options, "zoom");
        if (!bound.ok) return bound.message;
        if (!setZoom(action))
          return "The video changed for this call, but its preference could not be saved.";
        return action === "overview"
          ? "The whole screen will stay shown until you resume automatic zoom."
          : action === "resume"
            ? "Automatic zoom has resumed."
            : action === "disable"
              ? "Automatic zoom is disabled."
              : zoomStatus().overview
                ? "Automatic zoom is enabled; overview stays on until you ask to resume automatic zoom."
                : "Automatic zoom is enabled.";
      },
    }),
    ...(allowShape
      ? [
          tool({
            name: "picture_shape",
            description:
              "Choose the picture shape when the caller requests it: wide true shows the whole wide picture; false fits it into the middle for a phone cutting off the sides. Interpret the current caller's intent, including negation.",
            parameters: z.object({ wide: z.boolean() }).strict(),
            execute: async ({ wide }, options) => {
              const closed = active();
              if (closed) return closed;
              const bound = binding.take(options, "shape");
              return bound.ok ? reshape(wide) : bound.message;
            },
          }),
        ]
      : []),
  ];
}
