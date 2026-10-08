import console from 'node:console';
import { expect, it } from 'vitest';
import { createSecretBoundaryFixture } from './support/secret-boundary-fixture.js';

// PREPARATORY DRAFT (#119), not M5/#112 acceptance.
// Contract: PR #206 at 35f199d6b6960303f5909f19d65d3422ac2d8f3c,
// docs/security/policy-invariants.md: SEC-SEC-003 and SEC-POL-004.
// Tests run against actual M2 adapters, not the documentation branch.
// Keep the desired denial assertion RED if production isolation is absent.
const routes = ['direct', 'descendant', 'npm-test'] as const;

it.each(routes)('SEC-SEC-003: %s process excludes credential environment variables', async (route) => {
  const fixture = await createSecretBoundaryFixture();
  try {
    const { report, evidence } = await fixture.observe(route);
    console.info('SECRET_BOUNDARY_EVIDENCE ' + JSON.stringify({ assertion: 'environment', ...evidence }));
    expect(report.environment).toEqual({
      GITHUB_TOKEN: false,
      GH_TOKEN: false,
      CONTROL_PLANE_API_KEY: false,
      GRAM_MCP_INTERNAL_SECRET: false,
      OPENAI_ADMIN_KEY: false,
    });
  } finally {
    fixture.dispose();
  }
});

it.each(routes)('SEC-SEC-003 / SEC-POL-004: %s process cannot read provider-backed 0600 canaries', async (route) => {
  const fixture = await createSecretBoundaryFixture();
  try {
    const { report, evidence } = await fixture.observe(route);
    console.info('SECRET_BOUNDARY_EVIDENCE ' + JSON.stringify({ assertion: 'file-isolation', ...evidence }));
    expect({
      github: report.reads.github.readSucceeded,
      tunnel: report.reads.tunnel.readSucceeded,
      mcp: report.reads.mcp.readSucceeded,
    }, 'An ordinary task must not acquire credentials from the agent secret store').toEqual({
      github: false,
      tunnel: false,
      mcp: false,
    });
  } finally {
    fixture.dispose();
  }
});
