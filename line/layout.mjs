// Where things go on the picture of the call.
//
// The picture is 16 by 9, the size of the line's camera. What the caller sees of it is the line's Video framing,
// a setting of the line in Chert that is fixed for a whole call:
//  - "fit", Chert's default, sends the whole picture.
//  - "fill" turns the video upright and sends only the middle of the picture, so that it fills a phone held
//    upright. What is outside that middle strip is cut on the caller's screen.
// The agent cannot change the framing, so it draws for it. The layout "upright" keeps the stone, and a shared
// screen, inside the strip. The layout "wide" uses the whole picture.

export const FRAMINGS = ["fit", "fill"];
/**
 * The line's Video framing, from the setting of the agent. Anything else is "fit", as in Chert.
 * `phone` is the first name of this setting, which spoke of the phone: "upright" was the fill case.
 */
export function framingName(value, phone) {
  const named = String(value ?? "").toLowerCase();
  if (FRAMINGS.includes(named)) return named;
  return String(phone ?? "").toLowerCase() === "upright" ? "fill" : "fit";
}
/** The layout that a call starts with on a line of this framing. */
export const startLayout = (framing) =>
  framing === "fill" ? "upright" : "wide";

export const LAYOUTS = ["upright", "wide"];
/** A phone screen held upright: about 9 wide for 19.5 tall. */
export const PHONE_ASPECT = 9 / 19.5;

export const layoutName = (value) =>
  LAYOUTS.includes(String(value ?? "").toLowerCase())
    ? String(value).toLowerCase()
    : "upright";

/**
 * The part of the picture that the caller sees whole.
 * @returns {{ x: number, y: number, w: number, h: number }} in pixels of the picture
 */
export function seenBox(width, height, layout = "upright") {
  if (layoutName(layout) === "wide") return { x: 0, y: 0, w: width, h: height };
  const w = Math.min(width, Math.round(height * PHONE_ASPECT));
  return { x: Math.round((width - w) / 2), y: 0, w, h: height };
}

/** How tall the room for the small stone is, under a shared screen in the upright layout. */
export const STONE_ROOM = 132;

/**
 * Where a shared screen goes: the box it must fit into, and the size of the small stone and where it sits.
 * Upright: the screen fits into the strip, above the stone. Wide: the screen has the whole picture, and the
 * stone sits in the bottom right corner on it.
 */
export function screenLayout(width, height, layout = "upright") {
  const seen = seenBox(width, height, layout);
  if (layoutName(layout) === "wide")
    return {
      box: seen,
      stone: { size: 150, x: width - 24 - 150, y: height - 24 - 150 },
    };
  const size = STONE_ROOM - 22;
  return {
    box: { x: seen.x, y: 0, w: seen.w, h: height - STONE_ROOM },
    stone: {
      size,
      x: Math.round(seen.x + (seen.w - size) / 2),
      y: height - STONE_ROOM + 11,
    },
  };
}

/** A view is a part of the main screen, as shares of its width and height. Anything else is no view. */
export function cleanView(view) {
  if (!view || typeof view !== "object") return null;
  const { x, y, w, h } = view;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)))
    return null;
  const left = Math.min(1, Math.max(0, x)),
    top = Math.min(1, Math.max(0, y));
  const wide = Math.min(1 - left, Math.max(0, w)),
    tall = Math.min(1 - top, Math.max(0, h));
  // A part that is too small is not a window that a person asked to see.
  if (wide < 0.08 || tall < 0.08) return null;
  const round = (n) => Math.round(n * 10000) / 10000;
  return { x: round(left), y: round(top), w: round(wide), h: round(tall) };
}

/**
 * The ffmpeg filter that turns the captured screen into the picture: the part to show (the whole screen, or one
 * window), fitted into its box with its shape kept, on the dark ground of the picture.
 */
export function screenFilter({
  width,
  height,
  fps,
  layout = "upright",
  view = null,
  ground = "0x111317",
}) {
  const { box } = screenLayout(width, height, layout);
  const part = cleanView(view);
  const crop = part
    ? `crop=iw*${part.w}:ih*${part.h}:iw*${part.x}:ih*${part.y},`
    : "";
  // Even sizes: some scalers need them.
  const w = box.w - (box.w % 2),
    h = box.h - (box.h % 2);
  return `${crop}fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${width}:${height}:${box.x}+(${w}-iw)/2:${box.y}+(${h}-ih)/2:color=${ground}`;
}
