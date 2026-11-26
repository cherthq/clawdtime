/** Local review queue: interruption invalidates queued effects immediately.
 * Already dispatched native input is never claimed to be canceled. */
export class PreviewCommandQueue {
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(
    operation: () => Promise<T>,
    mutation = false,
    release = false,
  ): Promise<T> {
    const generation = this.generation;
    const result = this.tail.then(() => {
      if (mutation && !release && generation !== this.generation)
        throw new Error(
          "Queued effect canceled by presentation interruption; read current state.",
        );
      return operation();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  interrupt<T>(operation: () => Promise<T>): Promise<T> {
    this.generation += 1;
    // The controller serializes its clearing after any submitted camera write,
    // but must receive interruption now to invalidate that write's continuation.
    const result = operation();
    this.tail = Promise.allSettled([this.tail, result]);
    return result;
  }

  settled(): Promise<unknown> {
    return this.tail;
  }
}
