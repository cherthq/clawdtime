import { AsyncLocalStorage } from "node:async_hooks";
import type {
  PhoneTurnContext,
  PhonePresentation,
} from "../../src/phone-desktop-contracts.js";

export const phoneTurn = new AsyncLocalStorage<PhoneTurnContext>();
export const phoneEnded =
  "The call ended before this action could be completed. No further action was started.";
export function phoneIsLive() {
  return phoneTurn.getStore()?.isLive?.() !== false;
}
export function assertPhoneLive() {
  if (!phoneIsLive()) throw new Error("phone_call_expired");
}

/** Guards every external invocation, including subprocesses after an awaited probe. */
export function phoneGuard<F extends (...args: any[]) => any>(fn: F): F {
  return function (this: unknown, ...args: Parameters<F>) {
    assertPhoneLive();
    return fn.apply(this, args);
  } as F;
}

/** Bind class methods to their owner; proxy only the explicitly named effect ports. */
export function guardPhonePort<T extends object>(
  port: T,
  effects: readonly string[],
  children: Record<string, object> = {},
): T {
  return new Proxy(port, {
    get(target, key) {
      if (typeof key === "string" && children[key]) return children[key];
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      return typeof key === "string" && effects.includes(key)
        ? phoneGuard(bound)
        : bound;
    },
  });
}

export function presentationFact(value: PhonePresentation): string {
  if (!value.applied)
    return "The requested call presentation change was not applied.";
  if (value.kind === "sharing")
    return value.action === "show"
      ? "Screen sharing is on."
      : "Screen sharing is off.";
  if (value.kind === "shape")
    return value.action === "wide"
      ? "The call video is wide."
      : "The call video is upright.";
  return {
    overview: "The call video shows the overview.",
    enable: "Call auto-zoom is on.",
    disable: "Call auto-zoom is off.",
    resume: "Call auto-zoom has resumed.",
  }[value.action];
}
