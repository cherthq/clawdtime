import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const equal = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
// AES-GCM envelope retained from Apple Teams src/security.ts; fresh ClawdTime key only.
export class Vault {
  constructor(private key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw new Error("Encryption key must be 64 hex characters.");
  }
  seal(value: unknown) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", Buffer.from(this.key, "hex"), iv);
    const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return [iv, c.getAuthTag(), data]
      .map((v) => v.toString("base64url"))
      .join(".");
  }
  open<T>(value: string): T {
    const [iv, tag, data] = value
      .split(".")
      .map((v) => Buffer.from(v, "base64url"));
    if (!iv || !tag || !data) throw new Error("Invalid envelope.");
    const d = createDecipheriv("aes-256-gcm", Buffer.from(this.key, "hex"), iv);
    d.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([d.update(data), d.final()]).toString(),
    ) as T;
  }
}
export class DomainError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
