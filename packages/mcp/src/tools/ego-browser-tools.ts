import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeJsonResult } from './read-sanitizer.js';

/** Only fixed, publicly viewable discovery pages; no user-controlled URL, JS, selectors or login. */
export const EgoPublicSource = z.enum([
  'naver_best_viewed',
  'naver_best_keywords',
  '29cm_best',
  'zigzag_brand_ranking',
  'musinsa_home',
  'ably_home',
]);
export const EgoPublicReadInput = z.object({ source: EgoPublicSource }).strict();
export type EgoPublicSourceId = z.infer<typeof EgoPublicSource>;
export type EgoPublicReadInputValue = z.infer<typeof EgoPublicReadInput>;

export interface EgoPublicSnapshot {
  source: EgoPublicSourceId;
  pageKind: 'product_rankings' | 'keyword_rankings' | 'brand_rankings' | 'best_items' | 'discovery';
  requestedUrl: string;
  actualUrl: string;
  observedAt: string;
  snapshot: string;
  truncated: boolean;
  /** A page observation alone does not prove sales volumes or changes in ranks. */
  evidence: 'page_snapshot_only';
}

export interface EgoBrowserToolsPort {
  read(input: EgoPublicReadInputValue): Promise<EgoPublicSnapshot>;
}

export function registerEgoBrowserTools(server: McpServer, port: EgoBrowserToolsPort): void {
  server.registerTool('ego_public_shopping_snapshot', {
    description: 'Read a bounded, publicly visible shopping/best-items page using owner-installed ego(lite). Fixed allowlisted sources only. Read-only: no clicks, credentials, orders, arbitrary URLs or ranking claims. Available only after local host bridge opt-in.',
    inputSchema: EgoPublicReadInput,
  }, async (input) => {
    try {
      return safeJsonResult(await port.read(input));
    } catch {
      // In particular, never forward ego CLI stdout/stderr or local paths on errors.
      throw new Error('Ego public shopping snapshot unavailable or denied');
    }
  });
}
