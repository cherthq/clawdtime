import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { Adapter, AgentSession, Pairing } from "../../src/contracts.js";
import { validateOrigin } from "./client.js";

export interface Connection {
  schemaVersion: 1;
  baseUrl: string;
  pairing: Pairing;
  token: string;
  adapter: Adapter;
  adapterVersion: string;
  projectRoot: string;
  hostId: string;
  installed?: {
    configPath: string;
    configEntry: unknown;
    skillPath: string;
    skillHash: string;
  };
}
export interface RunState {
  schemaVersion: 1;
  runId: string;
  projectRoot: string;
  adapter: Adapter;
  session?: AgentSession;
  token?: string;
}
export function canonicalProject(project: string) {
  return realpathSync(project);
}
export function stateDirectory() {
  return (
    process.env.CLAWDTIME_CONFIG_HOME ||
    join(homedir(), ".local", "share", "clawdtime")
  );
}
export function connectionPath(
  project: string,
  adapter: Adapter,
  root = stateDirectory(),
) {
  const key = createHash("sha256")
    .update(`${canonicalProject(project)}\0${adapter}`)
    .digest("hex")
    .slice(0, 24);
  return join(root, "connections", key, "connection.json");
}
export function secureWrite(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && lstatSync(file).isSymbolicLink())
    throw new Error("Refusing symbolic-link credential path.");
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}
export function secureRead<T>(file: string): T {
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error(
      "Credential file must be a regular owner-only file (chmod 600).",
    );
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
export function loadConnection(
  file: string,
  project: string,
  adapter: Adapter,
): Connection {
  const connection = secureRead<Connection>(file);
  if (
    connection.schemaVersion !== 1 ||
    connection.projectRoot !== canonicalProject(project) ||
    connection.adapter !== adapter ||
    !connection.token
  )
    throw new Error("Connection belongs to a different project or adapter.");
  validateOrigin(connection.baseUrl);
  return connection;
}
