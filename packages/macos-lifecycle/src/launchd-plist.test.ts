import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { renderPlist, xmlText } from './launchd-plist.js';

const input = { schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false } };

describe('fixed-role launchd plist', () => {
  it('keeps the fixed path with spaces in one XML argument', () => {
    const xml = renderPlist(parseConfig(input), 'core');
    expect(xml).toContain('<string>/Library/Application Support/HAAR/GramAgent/releases/lab-001/bin/node</string>');
    expect(xml).toContain('<string>/Library/Application Support/HAAR/GramAgent/releases/lab-001/packages/macos-lifecycle/dist/supervisor-cli.js</string>');
    expect(xml).toContain('<string>--role</string><string>core</string>');
    expect(xml).toContain('<string>--config</string><string>/Library/Application Support/HAAR/GramAgent/config/service.json</string>');
    expect(xml).toContain('<key>UserName</key><string>gram-agent</string>');
    expect(xml).toContain('<key>Label</key><string>com.haar.gram-agent.core</string>');
  });
  it('uses exact throttling and shutdown settings without secret or shell interpolation', () => {
    const xml = renderPlist(parseConfig(input), 'core');
    for (const fragment of ['<key>RunAtLoad</key><true/>', '<key>KeepAlive</key><true/>',
      '<key>ThrottleInterval</key><integer>30</integer>', '<key>ExitTimeOut</key><integer>30</integer>',
      '<key>Umask</key><integer>63</integer>', '<key>StandardOutPath</key><string>/dev/null</string>',
      '<key>StandardErrorPath</key><string>/dev/null</string>']) expect(xml).toContain(fragment);
    for (const forbidden of ['CONTROL_PLANE_API_KEY', 'EnvironmentVariables', '/bin/sh', '/usr/bin/env',
      'NetworkState', 'AbandonProcessGroup', input.releaseDigest]) expect(xml).not.toContain(forbidden);
    expect([...xml.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1])).toEqual([
      'Label', 'UserName', 'ProgramArguments', 'WorkingDirectory', 'RunAtLoad', 'KeepAlive',
      'ThrottleInterval', 'ExitTimeOut', 'Umask', 'StandardOutPath', 'StandardErrorPath',
    ]);
  });
  it('refuses a disabled tunnel descriptor', () => {
    expect(() => renderPlist(parseConfig(input), 'tunnel')).toThrow(/^INVALID_CONFIG$/);
  });
  it('renders only the fixed enabled tunnel role', () => {
    const config = parseConfig({ ...input, tunnel: { enabled: true,
      compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' } });
    const xml = renderPlist(config, 'tunnel');
    expect(xml).toContain('<string>com.haar.gram-agent.tunnel</string>');
    expect(xml).toContain('<string>--role</string><string>tunnel</string>');
    expect(xml).not.toContain('test-tunnel-key');
  });
  it('escapes XML metacharacters', () => {
    expect(xmlText('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});
