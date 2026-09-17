import { createHash } from 'node:crypto';
import type { PolicyDecision } from '@gram/domain';
import type { NormalizedOperation } from './command-parser.js';
import { classifyRisk, type PolicyContext } from './risk-classifier.js';

export type { PolicyContext } from './risk-classifier.js';

function operationHash(operation: NormalizedOperation, context: PolicyContext): string {
  return createHash('sha256')
    .update(JSON.stringify({
      taskId: context.taskId,
      type: operation.type,
      executable: operation.executable,
      args: operation.args,
      canonicalTargets: operation.canonicalTargets,
    }))
    .digest('hex');
}

export class PolicyEngine {
  evaluate(operation: NormalizedOperation, context: PolicyContext): PolicyDecision {
    const classified = classifyRisk(operation, context);
    return {
      ...classified,
      operationHash: operationHash(operation, context),
    };
  }
}
