import { describe, expect, it, vi } from 'vitest';
import {
  buildEgoReadScript, buildTrustedEgoInvocation, createEgoPublicReader, parseEgoOutput,
} from './ego-browser-readonly.js';

const MARKER = 'GRAM_EGO_PUBLIC_SNAPSHOT_V1:';

function result(url: string, snapshot = '1 위 상품 A', truncated = false) {
  return 'ego(lite) CLI banner\n' + MARKER + JSON.stringify({ url, snapshot, truncated }) + '\n';
}

describe('HAAR fixed-source ego(lite) host adapter', () => {
  it('only requests an allowlisted public ranking page and never emits browser interaction code', async () => {
    const execute = vi.fn(async () => result('https://snxbest.naver.com/product/best/click'));
    const reader = createEgoPublicReader({ mode: 'windows', execute });
    const view = await reader.read({ source: 'naver_best_viewed' });
    expect(view.pageKind).toBe('product_rankings');
    expect(view.evidence).toBe('page_snapshot_only');
    expect(view.snapshot).toContain('상품 A');
    const script = execute.mock.calls[0]?.[0] ?? '';
    expect(script).toContain('https://snxbest.naver.com/product/best/click');
    expect(script).toContain('openOrReuseTab');
    expect(script).toContain('snapshotText');
    expect(script).not.toMatch(/await (?:click|fillInput|typeText|pressKey|uploadFile|httpGet)\(/u);
    expect(script).not.toContain('evil.example');
  });

  it('rejects arbitrary source keys even when TypeScript callers are bypassed', async () => {
    const execute = vi.fn(async () => result('https://snxbest.naver.com/home'));
    const reader = createEgoPublicReader({ mode: 'native', execute });
    await expect(reader.read({ source: 'https://evil.example' as never })).rejects.toThrow('Unapproved ego source');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when a page redirects outside its own permitted host or to an account page', async () => {
    const execute = vi.fn(async () => result('https://snxbest.naver.com.evil.test/'));
    const reader = createEgoPublicReader({ mode: 'windows', execute });
    await expect(reader.read({ source: 'naver_best_viewed' })).rejects.toThrow('Unexpected navigation');
    execute.mockResolvedValueOnce(result('https://snxbest.naver.com/checkout'));
    await expect(reader.read({ source: 'naver_best_viewed' })).rejects.toThrow('Unexpected navigation');
    execute.mockResolvedValueOnce(result('http://snxbest.naver.com/home'));
    await expect(reader.read({ source: 'naver_best_viewed' })).rejects.toThrow('Unexpected navigation');
  });

  it('redacts accidentally visible personal or secret-like text', async () => {
    const snapshot = '이름 user@example.com 010-1234-5678 Authorization: Bearer ABCDEFGHIJKLMNO';
    const execute = vi.fn(async () => result('https://snxbest.naver.com/home', snapshot));
    const view = await createEgoPublicReader({ mode: 'native', execute }).read({ source: 'naver_best_keywords' });
    expect(view.snapshot).not.toContain('user@example.com');
    expect(view.snapshot).not.toContain('010-1234-5678');
    expect(view.snapshot).not.toContain('ABCDEFGHIJKLMNO');
  });

  it('requires a single bounded structured CLI result, never passing raw stderr or arbitrary logs', () => {
    expect(parseEgoOutput(result('https://example.com/')).snapshot).toContain('상품 A');
    expect(() => parseEgoOutput('PRIVATE_SECRET: no result')).toThrow('Missing or ambiguous');
    expect(() => parseEgoOutput(result('https://example.com/') + result('https://example.com/')))
      .toThrow('Missing or ambiguous');
    expect(() => parseEgoOutput(MARKER + '{"url":"https://x","snapshot":"'.concat('a'.repeat(13000), '","truncated":false}')))
      .toThrow('Invalid result fields');
  });

  it('creates only the known executable and a generated encoded Windows host wrapper', () => {
    const script = buildEgoReadScript({
      url: 'https://snxbest.naver.com/home', hosts: ['snxbest.naver.com'], pageKind: 'keyword_rankings',
    });
    const native = buildTrustedEgoInvocation(script, 'native');
    expect(native).toEqual({ executable: 'ego-browser', args: ['nodejs'], stdin: script });
    const windows = buildTrustedEgoInvocation(script, 'windows');
    expect(windows.executable).toBe('powershell.exe');
    expect(windows.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const hostScript = Buffer.from(windows.args[4] ?? '', 'base64').toString('utf16le');
    expect(hostScript).toContain('Get-Command ego-browser -CommandType Application');
    expect(hostScript).toContain('nodejs');
    expect(hostScript).not.toContain('Invoke-Expression');
    expect(hostScript).not.toContain('Start-Process');
    expect(hostScript).not.toContain('evil.example');
  });

  it('never asserts product rank on unranked discovery pages', async () => {
    const execute = vi.fn(async () => result('https://mobile.a-bly.com/', '에이블리 홈페이지'));
    const view = await createEgoPublicReader({ mode: 'windows', execute }).read({ source: 'ably_home' });
    expect(view.pageKind).toBe('discovery');
    expect(view.evidence).toBe('page_snapshot_only');
  });
});
