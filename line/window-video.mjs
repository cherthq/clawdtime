// Transient, presentation-only pixels. This module never captures or controls a window.
const positiveInt = (n) => Number.isSafeInteger(n) && n > 0 && n <= 8192;
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const rect = (r, width, height) =>
  r &&
  ["x", "y", "width", "height"].every((k) => finite(r[k])) &&
  r.x >= 0 &&
  r.y >= 0 &&
  r.width > 0 &&
  r.height > 0 &&
  r.x + r.width <= width &&
  r.y + r.height <= height;

/** Returns null to show the neutral mascot when source/frame/transform is invalid. */
export function composeWindow(source, layout, width, height) {
  if (!positiveInt(width) || !positiveInt(height) || width * height > 8_294_400)
    throw Error("Invalid output size");
  if (
    !layout?.visible ||
    !source ||
    source.id !== layout.frameId ||
    !positiveInt(source.pixelWidth) ||
    !positiveInt(source.pixelHeight) ||
    source.pixelWidth * source.pixelHeight > 33_177_600 ||
    !(source.pixels instanceof Uint8Array) ||
    source.pixels.length !== source.pixelWidth * source.pixelHeight * 4 ||
    !rect(layout.crop, source.pixelWidth, source.pixelHeight) ||
    !rect(layout.contentRect, width, height)
  )
    return null;
  const output = new Uint8Array(width * height * 4);
  for (let i = 0; i < output.length; i += 4) {
    output[i] = 17;
    output[i + 1] = 19;
    output[i + 2] = 23;
    output[i + 3] = 255;
  }
  const c = layout.crop,
    d = layout.contentRect;
  for (
    let y = Math.ceil(d.y);
    y < Math.min(height, Math.floor(d.y + d.height));
    y++
  ) {
    const sy = Math.min(
      source.pixelHeight - 1,
      Math.floor(c.y + ((y - d.y) / d.height) * c.height),
    );
    for (
      let x = Math.ceil(d.x);
      x < Math.min(width, Math.floor(d.x + d.width));
      x++
    ) {
      const sx = Math.min(
        source.pixelWidth - 1,
        Math.floor(c.x + ((x - d.x) / d.width) * c.width),
      );
      const from = (sy * source.pixelWidth + sx) * 4,
        to = (y * width + x) * 4;
      output[to] = source.pixels[from];
      output[to + 1] = source.pixels[from + 1];
      output[to + 2] = source.pixels[from + 2];
      output[to + 3] = 255;
    }
  }
  // Only an independently qualified overlay-excluded source permits another cursor.
  if (
    layout.cursor &&
    layout.cursorStatus === "excluded" &&
    finite(layout.cursor.x) &&
    finite(layout.cursor.y)
  ) {
    const cx = Math.round(layout.cursor.x),
      cy = Math.round(layout.cursor.y);
    for (let y = 0; y < 19; y++)
      for (let x = 0; x <= Math.floor(y * 0.65); x++) {
        const px = cx + x,
          py = cy + y;
        if (px < d.x || px >= d.x + d.width || py < d.y || py >= d.y + d.height)
          continue;
        const at = (py * width + px) * 4,
          edge = x === 0 || x === Math.floor(y * 0.65) || y === 18;
        output[at] = edge ? 255 : 40;
        output[at + 1] = edge ? 255 : 220;
        output[at + 2] = edge ? 255 : 210;
      }
  }
  return output;
}
