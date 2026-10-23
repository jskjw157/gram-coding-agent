import { spawn } from 'node:child_process';
import type { EgoBrowserToolsPort, EgoPublicSnapshot, EgoPublicSourceId } from '@gram/mcp';

type HostMode = 'windows' | 'native';
type PageKind = EgoPublicSnapshot['pageKind'];
type Target = { url: string; hosts: readonly string[]; pageKind: PageKind };

const TARGETS: Record<EgoPublicSourceId, Target> = {
  naver_best_viewed: { url: 'https://snxbest.naver.com/product/best/click',
    hosts: ['snxbest.naver.com'], pageKind: 'product_rankings' },
  naver_best_keywords: { url: 'https://snxbest.naver.com/home',
    hosts: ['snxbest.naver.com'], pageKind: 'keyword_rankings' },
  '29cm_best': { url: 'https://www.29cm.co.kr/store/best-items?category_large_code=268100100',
    hosts: ['www.29cm.co.kr', '29cm.co.kr'], pageKind: 'best_items' },
  zigzag_brand_ranking: { url: 'https://zigzag.kr/brand/shop-list',
    hosts: ['zigzag.kr', 'www.zigzag.kr'], pageKind: 'brand_rankings' },
  // These are discovery-only home pages, not ranked product feeds.
  musinsa_home: { url: 'https://www.musinsa.com/',
    hosts: ['www.musinsa.com', 'musinsa.com'], pageKind: 'discovery' },
  ably_home: { url: 'https://a-bly.com/',
    hosts: ['a-bly.com', 'www.a-bly.com', 'mobile.a-bly.com'], pageKind: 'discovery' },
};

const MARKER = 'GRAM_EGO_PUBLIC_SNAPSHOT_V1:';
const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_OUTPUT_BYTES = 96 * 1024;
const TIMEOUT_MS = 75_000;

export interface EgoBrowserOptions {
  mode: HostMode;
  /** Test-only injectable backend; production uses a fixed, owner-opted-in CLI bridge. */
  execute?: (script: string) => Promise<string>;
}

/** Inputs are typed platform IDs, never caller-supplied URLs, scripts or selectors. */
export function createEgoPublicReader(options: EgoBrowserOptions): EgoBrowserToolsPort {
  if (options.mode !== 'windows' && options.mode !== 'native') throw new Error('Invalid ego host mode');
  return {
    async read({ source }): Promise<EgoPublicSnapshot> {
      if (!Object.hasOwn(TARGETS, source)) throw new Error('Unapproved ego source');
      const target = TARGETS[source];
      const execute = options.execute ?? ((code: string) => executeTrustedEgo(code, options.mode));
      const result = parseEgoOutput(await execute(buildEgoReadScript(target)));
      if (!isAllowedPageUrl(result.url, target.hosts)) throw new Error('Unexpected navigation outside public host');
      return {
        source, pageKind: target.pageKind, requestedUrl: target.url, actualUrl: result.url,
        observedAt: new Date().toISOString(), snapshot: redactPublicSnapshot(result.snapshot),
        truncated: result.truncated, evidence: 'page_snapshot_only',
      };
    },
  };
}

function isAllowedPageUrl(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) ||
        url.username !== '' || url.password !== '' || url.port !== '') return false;
    return !/(?:^|\/)(?:login|signin|account|mypage|my-page|order|checkout|payment)(?:\/|$)/iu.test(url.pathname);
  } catch { return false; }
}

/** All browser logic is authored by the agent, never by an MCP caller. No click or fill. */
export function buildEgoReadScript(target: Target): string {
  return [
    "await useOrCreateTaskSpace('HAAR public shopping observation')",
    'await openOrReuseTab(' + JSON.stringify(target.url) + ', { wait: true, timeout: 20 })',
    'const current = await pageInfo()',
    "const finalUrl = String(current?.url ?? current?.href ?? current?.currentUrl ?? '')",
    'const allowedHosts = ' + JSON.stringify(target.hosts),
    'let approved = false',
    "try { const parsed = new URL(finalUrl); approved = parsed.protocol === 'https:' && allowedHosts.includes(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port && !/(?:^|\\/)(?:login|signin|account|mypage|my-page|order|checkout|payment)(?:\\/|$)/i.test(parsed.pathname) } catch {}",
    "if (!approved) throw new Error('Public page redirected or unavailable')",
    'const raw = await snapshotText()',
    "const text = typeof raw === 'string' ? raw : JSON.stringify(raw)",
    'cliLog(' + JSON.stringify(MARKER) + ' + JSON.stringify({ url: finalUrl, snapshot: text.slice(0, ' + MAX_SNAPSHOT_CHARS + '), truncated: text.length > ' + MAX_SNAPSHOT_CHARS + ' }))',
    '',
  ].join('\n');
}

export function parseEgoOutput(output: string): { url: string; snapshot: string; truncated: boolean } {
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('Ego output too long');
  const lines = output.split(/\r?\n/u).filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) throw new Error('Missing or ambiguous structured result');
  let parsed: unknown;
  try { parsed = JSON.parse((lines[0] ?? '').slice(MARKER.length)); }
  catch { throw new Error('Invalid structured result'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid result');
  const v = parsed as Record<string, unknown>;
  if (typeof v.url !== 'string' || v.url.length > 2048 ||
      typeof v.snapshot !== 'string' || v.snapshot.length > MAX_SNAPSHOT_CHARS ||
      typeof v.truncated !== 'boolean') throw new Error('Invalid result fields');
  return { url: v.url, snapshot: v.snapshot, truncated: v.truncated };
}

function redactPublicSnapshot(content: string): string {
  return content
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[EMAIL REDACTED]')
    .replace(/\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/gu, '[PHONE REDACTED]')
    .replace(/(?:bearer\s+|(?:api[_-]?key|access[_-]?token|session[_-]?id)\s*[:=]\s*)[A-Za-z0-9._-]{12,}/giu, '[CREDENTIAL REDACTED]');
}

export interface EgoInvocation {
  executable: string;
  args: string[];
  stdin?: string;
}

/** A fixed PowerShell host bridge on WSL; NO general shell or arbitrary JS MCP API. */
export function buildTrustedEgoInvocation(script: string, mode: HostMode): EgoInvocation {
  if (mode === 'native') return { executable: 'ego-browser', args: ['nodejs'], stdin: script };
  if (mode !== 'windows') throw new Error('Invalid ego host mode');
  const encodedScript = Buffer.from(script, 'utf8').toString('base64');
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedScript + "'))",
    "$installRoot = Join-Path $env:ProgramFiles 'Citro Labs\\ego lite\\Application'",
    "$versions = @(Get-ChildItem -LiteralPath $installRoot -Directory -ErrorAction Stop | Where-Object { $_.Name -match '^\\d+\\.\\d+\\.\\d+\\.\\d+
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\r\n');
  return { executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')] };
}

/** Shell:false, bounded output, time limit, secret-safe failure messages. */
async function executeTrustedEgo(script: string, mode: HostMode): Promise<string> {
  const invocation = buildTrustedEgoInvocation(script, mode);
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let byteCount = 0;
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'LOCALAPPDATA', 'APPDATA']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const child = spawn(invocation.executable, invocation.args, {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) reject(error);
      else resolve(output ?? '');
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Ego host timed out'));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      byteCount += Buffer.byteLength(chunk);
      if (byteCount > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('Ego host output exceeded bound'));
      } else stdout += chunk;
    });
    child.stderr.on('data', () => {}); // Drain but never log potentially sensitive stderr.
    child.once('error', () => finish(new Error('Ego host process unavailable')));
    child.once('close', code => code === 0 ? finish(undefined, stdout) : finish(new Error('Ego host command failed')));
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.stdin ?? '');
  });
}
 } | Sort-Object -Property @{ Expression = { [version]$_.Name }; Descending = $true })",
    "$browser = $null",
    "foreach ($version in $versions) { $candidate = Join-Path $version.FullName 'ego-browser.exe'; if ([IO.File]::Exists($candidate) -and -not (([IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint)) { $browser = $candidate; break } }",
    "if ($null -eq $browser) { throw 'Ego browser executable unavailable in protected installation directory' }",
    '$payload | & $browser nodejs',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\r\n');
  return { executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')] };
}

/** Shell:false, bounded output, time limit, secret-safe failure messages. */
async function executeTrustedEgo(script: string, mode: HostMode): Promise<string> {
  const invocation = buildTrustedEgoInvocation(script, mode);
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let byteCount = 0;
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'LOCALAPPDATA', 'APPDATA']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const child = spawn(invocation.executable, invocation.args, {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) reject(error);
      else resolve(output ?? '');
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Ego host timed out'));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      byteCount += Buffer.byteLength(chunk);
      if (byteCount > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('Ego host output exceeded bound'));
      } else stdout += chunk;
    });
    child.stderr.on('data', () => {}); // Drain but never log potentially sensitive stderr.
    child.once('error', () => finish(new Error('Ego host process unavailable')));
    child.once('close', code => code === 0 ? finish(undefined, stdout) : finish(new Error('Ego host command failed')));
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.stdin ?? '');
  });
}
