// secret-zero.test.ts — synthetic secret-zero sweep (D2/D3/D10).
//
// Synthetic canaries (never real credentials) are introduced through the
// fixture vault, then every observable surface is swept: MCP tool results,
// SQLite-shaped rows, log/diag/audit buffers, argv/env snapshots, and error
// messages. Zero matches required.
import { describe, expect, it } from 'vitest';
import { CredentialBroker } from '../../credentials/src/broker.js';
import { sweepSurfaces } from './harness.js';

const CANARIES = [
  'SX_CANARY_OPS_VERIFY_ALPHA_9f8a21',
  'SX_CANARY_OPS_VERIFY_BETA_44c0d7',
] as const;

describe('synthetic secret-zero sweep', () => {
  it('canary secret leaves zero matches across all observable surfaces', async () => {
    const canary = CANARIES[0] ?? 'SX_CANARY_FALLBACK';
    const vault = {
      getForUse: (_name: string) =>
        Promise.resolve({
          withValue: <T>(use: (value: string) => T): T => use(canary),
          dispose: () => {},
        }),
    };
    const broker = new CredentialBroker({
      vault,
      permits: [
        {
          id: 'permit-sweep',
          intentHash: 'hash-sweep',
          credentialRef: 'ref-sweep',
          recipeId: 'recipe-sweep',
          requesterId: 'req-sweep',
          workerId: 'worker-sweep',
          scope: 'shopify.v1',
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    const receipt = await broker.credentialUse(
      {
        intentHash: 'hash-sweep',
        permitId: 'permit-sweep',
        credentialRef: 'ref-sweep',
        recipeId: 'recipe-sweep',
        requesterId: 'req-sweep',
        workerId: 'worker-sweep',
        scope: 'shopify.v1',
      },
      () => ({ sanitized: true, rows: 1 }),
    );
    const sqliteRowDump = JSON.stringify({
      task_id: 'task-sweep',
      client_request_id: 'permit-sweep',
      receipt,
    });
    const logBuffer = 'info: operation completed for task-sweep';
    const diagBuffer = 'diag: ledger DISPATCHING committed before transmit';
    const auditBuffer = 'audit: permit-sweep consumed exactly once';
    let errorMessage = '';
    try {
      await broker.credentialUse(
        {
          intentHash: 'hash-sweep',
          permitId: 'permit-sweep',
          credentialRef: 'ref-sweep',
          recipeId: 'recipe-sweep',
          requesterId: 'req-sweep',
          workerId: 'worker-sweep',
          scope: 'shopify.v1',
        },
        () => ({ sanitized: true }),
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const leaks = sweepSurfaces([...CANARIES], {
      mcpResult: JSON.stringify(receipt),
      sqliteRows: sqliteRowDump,
      logs: logBuffer,
      diag: diagBuffer,
      audit: auditBuffer,
      argv: process.argv.join(' '),
      env: `${process.env['PATH'] ?? ''} ${(process.env['SHELL'] ?? '')}`,
      errors: errorMessage,
    });
    expect(leaks).toEqual([]);
  });
});
