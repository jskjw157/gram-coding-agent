import { decideRollbackSchema } from '../adapters/closed-schema.js';
import type { ClosedSchemaReading } from './contracts.js';

export function guardRollbackSchema(reading: ClosedSchemaReading, accepted: readonly (readonly number[])[] | null): {
  ok: boolean;
  code: 'OK' | 'ROLLBACK_BLOCKED_SCHEMA';
} {
  if (reading.state === 'absent') {
    return decideRollbackSchema({ state: 'absent', versions: null, accepted });
  }
  if (reading.state !== 'present' || reading.versions === null) {
    return decideRollbackSchema({ state: reading.state, versions: null, accepted });
  }
  return decideRollbackSchema({ state: 'present', versions: reading.versions, accepted });
}
