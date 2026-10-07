/** Full sealed-release review budget. HTTP requests and native peer probes
 * retain their separate short deadlines. A caller's earlier abort always wins.
 */
export const RELEASE_REVIEW_TIMEOUT_MS = 60_000;
