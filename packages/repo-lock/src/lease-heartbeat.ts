export interface IntervalScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export const nativeIntervalScheduler: IntervalScheduler = {
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export class LeaseHeartbeat {
  private handle: unknown | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly scheduler: IntervalScheduler,
    private readonly intervalMs: number,
    private readonly beat: () => Promise<void>,
    private readonly onFailure: (error: unknown) => Promise<void> | void,
  ) {}

  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.scheduler.setInterval(() => {
      this.inFlight = (async () => {
        try {
          await this.beat();
        } catch (beatError: unknown) {
          this.stop();
          try {
            await this.onFailure(beatError);
          } catch {
            // The beat already failed and the timer is stopped; a failing
            // recovery callback (e.g. SQLite already closed during shutdown)
            // must never surface as an unhandled rejection.
          }
        }
      })();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = undefined;
  }

  /**
   * Resolves once no tick callback is still executing, including its failure
   * recovery path. Never rejects. Call `stop()` first so no new tick can start
   * while draining. This is what lets a lease be quiesced (timer stopped, lease
   * still held) without a beat touching SQLite after the database is closed.
   */
  async drain(): Promise<void> {
    await this.inFlight;
  }
}
