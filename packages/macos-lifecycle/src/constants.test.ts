import { describe, expect, it } from 'vitest';
import { labels } from './contracts.js';
import { parseConfig } from './config.js';
import { renderPlist } from './launchd-plist.js';

describe('fixed service identity', () => {
  it.each(['core', 'tunnel'] as const)('cannot replace the %s label through its exported object', role => {
    const original = labels[role];
    try {
      const changed = Reflect.set(labels, role, 'foreign.service');
      const config = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
        releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: {
          enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key',
        } });
      const xml = renderPlist(config, role);
      expect(xml).toContain(`<key>Label</key><string>com.haar.gram-agent.${role}</string>`);
      expect(xml).not.toContain('foreign.service');
      expect(changed).toBe(false);
    } finally {
      Reflect.set(labels, role, original);
    }
  });
});
