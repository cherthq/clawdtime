import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The native programs that ClawdTime starts on this Mac. */
export type NativeHelper = "ClawdTimeTaskPanel" | "ClawdTimeTaskCapture";

interface Where {
  /** The checkout or the release runtime: the folder of package.json. */
  root: string;
  env?: Record<string, string | undefined>;
}

/**
 * Where a native helper can be, in order: the absolute folder named by
 * CLAWDTIME_NATIVE_DIR, the `native/` folder of a release runtime, then the
 * debug and release builds of a source checkout.
 */
export function nativeHelperCandidates(
  name: NativeHelper,
  { root, env = process.env }: Where,
): string[] {
  const named = env.CLAWDTIME_NATIVE_DIR;
  return [
    ...(named && isAbsolute(named) ? [join(named, name)] : []),
    join(root, "native", name),
    join(root, "mac", ".build", "debug", name),
    join(root, "mac", ".build", "release", name),
  ];
}

/** The first candidate that is a file this user can run, or undefined. */
export function findNativeHelper(
  name: NativeHelper,
  where: Where,
): string | undefined {
  for (const candidate of nativeHelperCandidates(name, where)) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
