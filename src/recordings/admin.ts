/**
 * The admin page of the call recordings, in the desktop service, on
 * 127.0.0.1 only: `/admin/recordings`. It lists the recorded calls of the
 * line on this Mac, shows a transcript, plays the audio and the video, and
 * gives each file and a zip of each call.
 *
 * Its credential is the admin token in `recordings-admin.json` of the desktop
 * state folder, an owner-only file that `clawdtime recordings admin` makes.
 * It is separate from the panel, session and operator credentials: a token
 * equal to one of them turns the page off. Without the file the page is off.
 *
 * The page is read only, and every route is a GET: the service refuses any
 * request that a browser marks with an origin, and a page of another site
 * cannot read or send the token. The token goes in an Authorization header
 * once; the answer is a session cookie for this path only (HttpOnly,
 * SameSite=Strict, 8 hours), so that the audio, video and download links work.
 * A request for another host name than 127.0.0.1 or localhost is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Context, Hono, Next } from "hono";
import { z } from "zod";
import { equal } from "../storage/security.js";
import {
  readPrivateJSON,
  writePrivateJSON,
} from "../../connectors/shared/private-file.js";
import { openCallFile, Recordings, zipFiles, zipList } from "./store.js";
import { pageCss, pageHtml, pageJs } from "./page.js";

export const ADMIN_BASE = "/admin/recordings";
const COOKIE = "clawdtime_recordings";
const SESSION_MS = 8 * 3_600_000;
const MAX_SESSIONS = 32;

/** The file of the admin token in a desktop state folder. */
export const adminTokenFile = (desktopFolder: string) =>
  join(desktopFolder, "recordings-admin.json");

const tokenSchema = z
  .object({ version: z.literal(1), token: z.string().min(32).max(200) })
  .strict();

/**
 * The admin token, or null when the page is off: no file, a file that is not
 * an owner-only file, or a token equal to another credential of the service.
 */
export function readAdminToken(
  file: string,
  others: (string | undefined)[] = [],
): string | null {
  const read = readPrivateJSON(file);
  const parsed = tokenSchema.safeParse(read.value);
  if (read.problem || !parsed.success) return null;
  const value = parsed.data.token;
  if (others.some((other) => other && equal(other, value))) return null;
  return value;
}

/** Makes a new admin token. The old one, and each session made with it, ends. */
export function makeAdminToken(file: string): void {
  writePrivateJSON(file, {
    version: 1,
    token: randomBytes(32).toString("base64url"),
  });
}

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export interface RecordingsAdminOptions {
  /** The recordings of the line, or null when no folder can be found. */
  recordings: () => Recordings | null;
  /** The file of the admin token (adminTokenFile). */
  tokenFile: string;
  /** The port of the service. Only 127.0.0.1 and localhost on it are served. */
  port: number;
  /** The other credentials of the service. The admin token must differ from each. */
  otherTokens?: () => (string | undefined)[];
  now?: () => number;
}

/** Mounts the admin page and its read-only API on the app of the desktop service. */
export function mountRecordingsAdmin(
  app: Hono,
  options: RecordingsAdminOptions,
) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { until: number; token: string }>();
  const hosts = new Set([
    `127.0.0.1:${options.port}`,
    `localhost:${options.port}`,
  ]);
  const token = () =>
    readAdminToken(options.tokenFile, options.otherTokens?.() ?? []);
  const bearer = (c: Context) => {
    const value = c.req.header("authorization");
    return value?.startsWith("Bearer ") ? value.slice(7) : "";
  };
  const cookie = (c: Context) => {
    for (const part of (c.req.header("cookie") ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE) return rest.join("=");
    }
    return "";
  };
  /** True when the request holds the admin token or a live session made with it. */
  const admitted = (c: Context, current: string) => {
    const given = bearer(c);
    if (given) return equal(given, current);
    const id = cookie(c);
    const session = id ? sessions.get(id) : undefined;
    if (!session) return false;
    if (session.until < now() || session.token !== fingerprint(current)) {
      sessions.delete(id);
      return false;
    }
    return true;
  };

  const guard = async (c: Context, next: Next) => {
    let host = "";
    try {
      host = new URL(c.req.url).host;
    } catch {
      /* refused below */
    }
    if (!hosts.has(host))
      return c.json({ error: "Open this page on 127.0.0.1." }, 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD")
      return c.json({ error: "This page only reads." }, 405);
    await next();
    c.header("Cache-Control", "no-store");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
  };
  app.use(ADMIN_BASE, guard);
  app.use(`${ADMIN_BASE}/*`, guard);

  // The page itself holds no data: it shows the sign-in until the API admits it.
  app.get(ADMIN_BASE, (c) => c.html(pageHtml));
  app.get(`${ADMIN_BASE}/app.css`, (c) =>
    c.body(pageCss, 200, { "Content-Type": "text/css; charset=utf-8" }),
  );
  app.get(`${ADMIN_BASE}/app.js`, (c) =>
    c.body(pageJs, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
    }),
  );

  const off = (c: Context) =>
    c.json(
      {
        error:
          "The admin page is off. To turn it on, run: clawdtime recordings admin",
      },
      403,
    );
  const refused = (c: Context) =>
    c.json({ error: "Sign in with the admin token." }, 401);

  app.get(`${ADMIN_BASE}/session`, (c) => {
    const current = token();
    if (!current) return off(c);
    const given = bearer(c);
    if (!given || !equal(given, current)) return refused(c);
    for (const [id, session] of sessions)
      if (session.until < now()) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS)
      sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, {
      until: now() + SESSION_MS,
      token: fingerprint(current),
    });
    c.header(
      "Set-Cookie",
      `${COOKIE}=${id}; Path=${ADMIN_BASE}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
    );
    return c.json({ ok: true });
  });
  app.get(`${ADMIN_BASE}/signout`, (c) => {
    const id = cookie(c);
    if (id) sessions.delete(id);
    c.header(
      "Set-Cookie",
      `${COOKIE}=; Path=${ADMIN_BASE}; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    return c.json({ ok: true });
  });

  /** Runs `read` for an admitted request with the recordings of the line. */
  const api =
    (
      read: (
        c: Context,
        recordings: Recordings,
      ) => Response | Promise<Response>,
    ) =>
    (c: Context) => {
      const current = token();
      if (!current) return off(c);
      if (!admitted(c, current)) return refused(c);
      const recordings = options.recordings();
      if (!recordings)
        return c.json(
          { error: "The recordings folder is not an absolute path." },
          409,
        );
      const problem = recordings.problem();
      if (problem) return c.json({ error: problem }, 409);
      return read(c, recordings);
    };
  app.get(
    `${ADMIN_BASE}/api/calls`,
    api((c, recordings) => c.json({ calls: recordings.list() })),
  );
  app.get(
    `${ADMIN_BASE}/api/calls/:id`,
    api((c, recordings) => {
      const found = recordings.get(c.req.param("id") ?? "");
      return found
        ? c.json(found)
        : c.json({ error: "There is no such call." }, 404);
    }),
  );
  app.get(
    `${ADMIN_BASE}/api/calls/:id/files/:name`,
    api((c, recordings) => {
      const id = c.req.param("id") ?? "";
      const file = recordings.file(id, c.req.param("name") ?? "");
      if (!file) return c.json({ error: "There is no such file." }, 404);
      const disposition = `${c.req.query("download") === "1" ? "attachment" : "inline"}; filename="${id}-${file.name}"`;
      const headers: Record<string, string> = {
        "Content-Type": file.type,
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
      };
      const range = /^bytes=([0-9]*)-([0-9]*)$/.exec(
        c.req.header("range") ?? "",
      );
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : file.size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : file.size - 1;
        start = Math.max(0, start);
        end = Math.min(end, file.size - 1);
        if (!(start <= end))
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${file.size}` },
          });
        return new Response(
          Readable.toWeb(openCallFile(file, { start, end })) as ReadableStream,
          {
            status: 206,
            headers: {
              ...headers,
              "Content-Length": String(end - start + 1),
              "Content-Range": `bytes ${start}-${end}/${file.size}`,
            },
          },
        );
      }
      return new Response(
        Readable.toWeb(openCallFile(file)) as ReadableStream,
        {
          status: 200,
          headers: { ...headers, "Content-Length": String(file.size) },
        },
      );
    }),
  );
  app.get(
    `${ADMIN_BASE}/api/calls/:id/zip`,
    api((c, recordings) => {
      const id = c.req.param("id") ?? "";
      if (!recordings.get(id))
        return c.json({ error: "There is no such call." }, 404);
      const files = zipList(recordings, id);
      return new Response(
        Readable.toWeb(Readable.from(zipFiles(files))) as ReadableStream,
        {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="clawdtime-call-${id}.zip"`,
          },
        },
      );
    }),
  );
}
