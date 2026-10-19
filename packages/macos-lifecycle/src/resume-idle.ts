import type { PortState } from './adapters/macos-service-probes.js';
import { readProof } from './proof-read.js';

/** Post-stop synchronization only, after an exact native FOREIGN observation.
 * Occupancy remains strict, including TIME_WAIT. No service operation occurs.
 * This new drain budget is separate from the unchanged release-review budget.
 */
export async function waitForResumeIdle(read: () => Promise<{ core: PortState; tunnel: PortState }>): Promise<boolean> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 90_000);
  let pause: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      const ports = await readProof(controller.signal, read);
      if (!['free', 'occupied'].includes(ports.core) || !['free', 'occupied'].includes(ports.tunnel)) return false;
      if (ports.core === 'free' && ports.tunnel === 'free') return true;
      await readProof(
        controller.signal,
        () =>
          new Promise<void>((resolve) => {
            pause = setTimeout(resolve, 200);
          }),
      );
    }
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
    clearTimeout(pause);
    controller.abort();
  }
}
