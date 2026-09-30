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

  constructor(
    private readonly scheduler: IntervalScheduler,
    private readonly intervalMs: number,
    private readonly beat: () => Promise<void>,
    private readonly onFailure: (error: unknown) => Promise<void> | void,
  ) {}

  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.scheduler.setInterval(() => {
      void (async () => {
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
}
