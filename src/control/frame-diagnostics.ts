import jpeg from "jpeg-js";

/** Diagnostic only. No similarity threshold or changed region authorizes input. */
export function describeFrameChange(before: string, after: string) {
  if (before === after) return { kind: "identical" as const };
  try {
    const decode = (url: string) => {
      const prefix = "data:image/jpeg;base64,";
      if (!url.startsWith(prefix) || url.length > 2_800_000) throw new Error();
      return jpeg.decode(Buffer.from(url.slice(prefix.length), "base64"), {
        useTArray: true,
        tolerantDecoding: false,
        maxResolutionInMP: 1,
        maxMemoryUsageInMB: 64,
      });
    };
    const a = decode(before),
      b = decode(after);
    if (a.width !== b.width || a.height !== b.height)
      return { kind: "geometry_changed" as const };
    const { width, height } = a;
    if (width > 1280 || height > 720) return { kind: "unavailable" as const };
    let changedPixels = 0;
    const tiles = new Set<number>();
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      if (
        a.data[i] === b.data[i] &&
        a.data[i + 1] === b.data[i + 1] &&
        a.data[i + 2] === b.data[i + 2]
      )
        continue;
      changedPixels++;
      tiles.add(
        Math.floor((Math.floor(p / width) * 3) / height) * 4 +
          Math.floor(((p % width) * 4) / width),
      );
    }
    a.data.fill(0);
    b.data.fill(0);
    return {
      kind: changedPixels
        ? ("pixels_changed" as const)
        : ("encoding_only" as const),
      width,
      height,
      changedPixels,
      changedTiles: [...tiles].sort((x, y) => x - y),
    };
  } catch {
    return { kind: "unavailable" as const };
  }
}
