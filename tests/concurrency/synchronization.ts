/** Explicit one-shot synchronization; timeouts belong to the test watchdog only. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

export class Checkpoint {
  readonly reached = deferred();
  private readonly permission = deferred();
  arrived = false;

  async wait(): Promise<void> {
    this.arrived = true;
    this.reached.resolve();
    await this.permission.promise;
  }

  open(): void {
    this.permission.resolve();
  }
}

/** All parties must arrive before the test can inspect their simultaneous state. */
export class Barrier {
  readonly reached = deferred();
  readonly arrivals = new Set<string>();
  private readonly permission = deferred();

  constructor(private readonly parties: number) {}

  async arriveAndWait(identity: string): Promise<void> {
    if (this.arrivals.has(identity)) throw new Error('Duplicate barrier arrival');
    this.arrivals.add(identity);
    if (this.arrivals.size === this.parties) this.reached.resolve();
    await this.permission.promise;
  }

  open(): void {
    this.permission.resolve();
  }
}
