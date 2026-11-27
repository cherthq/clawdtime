import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

/** Keyed digests and sealed copies of the phone numbers and other caller
 * handles of one shared line, under the coordinator's identity key. A digest
 * finds and compares a number without storing it. A sealed copy is kept only
 * where the number must be used again: to send a sign-in text, and to dial a
 * member's callback. Neither tells a number to anyone without the key. */
export class SharedNumberKeys {
  private readonly digestKey: Buffer;
  private readonly sealKey: Buffer;
  constructor(
    key: string,
    private readonly lineId: string,
  ) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw Error("identity_key_required");
    const root = Buffer.from(key, "hex");
    const derive = (purpose: string) =>
      createHmac("sha256", root).update(purpose).digest();
    this.digestKey = derive("shared-number-digest");
    this.sealKey = derive("shared-number-seal");
  }
  digest(handle: string) {
    return createHmac("sha256", this.digestKey)
      .update(JSON.stringify([this.lineId, handle]))
      .digest("hex");
  }
  seal(handle: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey, iv);
    cipher.setAAD(Buffer.from(this.lineId));
    const body = Buffer.concat([cipher.update(handle, "utf8"), cipher.final()]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }
  open(sealed: string) {
    const [version, data = ""] = sealed.split(".");
    const raw = Buffer.from(data, "base64url");
    if (version !== "v1" || raw.length < 29)
      throw Error("sealed_number_invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.sealKey,
      raw.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(this.lineId));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
}
