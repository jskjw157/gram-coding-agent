import { describe, expect, it } from 'vitest';
import { parseDisabledOverrides } from './adapters/macos-service-probes.js';

describe('observed native launchctl override spellings', () => {
  const spellings = [['enabled', false], ['disabled', true], ['false', false], ['true', true]] as const;
  it.each(spellings)('interprets %s as disabled=%s without inverting the meaning', (word, expected) => {
    expect(parseDisabledOverrides({ code: 0, stderr: '', stdout:
      `\n\tdisabled services = {\n\t\t"com.haar.gram-agent.core" => ${word}\n\t\t"com.haar.gram-agent.tunnel" => ${word}\n\t}\n` }))
      .toEqual({ core: expected, tunnel: expected });
  });
  it.each(['yes', 'no', 'ENABLED', 'unknown', '1', '0'])('rejects unverified spelling %s', word => {
    expect(parseDisabledOverrides({ code: 0, stderr: '', stdout:
      `disabled services = {\n "com.haar.gram-agent.core" => ${word}\n}\n` })).toBeNull();
  });
});
