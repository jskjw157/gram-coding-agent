/** Full sealed-release review budget. HTTP requests and native peer probes
 * retain their separate short deadlines. A caller's earlier abort always wins.
 */
export const RELEASE_REVIEW_TIMEOUT_MS = 60_000;

/** The complete Core startup, including its health protocol, remains bounded. */
export const CORE_STARTUP_TIMEOUT_MS = 60_000;
export const CORE_HEALTH_PROBE_TIMEOUT_MS = CORE_STARTUP_TIMEOUT_MS;

/** Installation must allow preparation, Core startup and a final sealed review.
 * Retries and backoff share this single absolute deadline.
 */
export const INSTALLED_HEALTH_TIMEOUT_MS = RELEASE_REVIEW_TIMEOUT_MS
  + CORE_STARTUP_TIMEOUT_MS + RELEASE_REVIEW_TIMEOUT_MS;
