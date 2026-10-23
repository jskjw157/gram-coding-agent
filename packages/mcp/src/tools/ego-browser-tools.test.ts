import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { EgoPublicReadInput, registerEgoBrowserTools } from './ego-browser-tools.js';

describe('ego-browser MCP tool boundary', () => {
  it('accepts enumerated public sources but never user URLs or code', () => {
    expect(EgoPublicReadInput.parse({ source: 'naver_best_viewed' })).toEqual({ source: 'naver_best_viewed' });
    expect(EgoPublicReadInput.safeParse({ source: 'https://evil.example/' }).success).toBe(false);
    expect(EgoPublicReadInput.safeParse({ source: 'naver_best_viewed', url: 'https://evil.example/' }).success).toBe(false);
    expect(EgoPublicReadInput.safeParse({ source: 'naver_best_viewed', script: 'click(...)' }).success).toBe(false);
  });

  it('registers a single typed read-only tool and passes only strict input to its port', async () => {
    let handler: ((input: { source: 'naver_best_viewed' }) => Promise<unknown>) | undefined;
    const registerTool = vi.fn((_name: string, _definition: unknown, callback: (input: { source: 'naver_best_viewed' }) => Promise<unknown>) => { handler = callback; });
    const server = { registerTool } as unknown as McpServer;
    const view = {
      source: 'naver_best_viewed' as const,
      pageKind: 'product_rankings' as const,
      requestedUrl: 'https://snxbest.naver.com/product/best/click',
      actualUrl: 'https://snxbest.naver.com/product/best/click',
      observedAt: '2026-10-23T00:00:00.000Z',
      snapshot: 'Top item',
      truncated: false,
      evidence: 'page_snapshot_only' as const,
    };
    const read = vi.fn(async () => view);
    registerEgoBrowserTools(server, { read });
    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerTool.mock.calls[0]?.[0]).toBe('ego_public_shopping_snapshot');
    expect(handler).toBeDefined();
    const result = await handler?.({ source: 'naver_best_viewed' }) as { content: { type: string; text: string }[] };
    expect(read).toHaveBeenCalledWith({ source: 'naver_best_viewed' });
    const text = result.content[0]?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text ?? '{}')).toEqual(view);
  });

  it('hides adapter failures and does not leak captured browser output', async () => {
    let handler: ((input: { source: 'naver_best_viewed' }) => Promise<unknown>) | undefined;
    const server = { registerTool: (_name: string, _definition: unknown, callback: typeof handler) => { handler = callback; } } as unknown as McpServer;
    registerEgoBrowserTools(server, { read: async () => { throw new Error('secret=PRIVATE_CREDENTIAL'); } });
    await expect(handler?.({ source: 'naver_best_viewed' })).rejects.toThrow('unavailable or denied');
  });
});
