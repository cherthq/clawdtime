import { Store } from "./store.js";
import { Vault } from "./security.js";

interface Envelope {
  id: string;
  ciphertext: string;
}

/** Task prose is necessary restart context, but never plaintext database metadata. */
export class ProtectedTaskStore<T extends { id: string }> {
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly kind: string,
  ) {}

  get(id: string): T | undefined {
    const row = this.store.get<Envelope>(this.kind, id);
    return row ? this.open(row) : undefined;
  }

  all(): T[] {
    return this.store.all<Envelope>(this.kind).map((row) => this.open(row));
  }

  put(value: T): T {
    this.store.put<Envelope>(this.kind, {
      id: value.id,
      ciphertext: this.vault.seal({ kind: this.kind, value }),
    });
    return structuredClone(value);
  }

  private open(row: Envelope): T {
    const decoded = this.vault.open<{ kind: string; value: T }>(row.ciphertext);
    if (decoded.kind !== this.kind || decoded.value.id !== row.id)
      throw new Error("Protected task record identity mismatch.");
    return decoded.value;
  }
}
