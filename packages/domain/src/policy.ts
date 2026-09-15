export type PolicyDecisionKind = 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY';

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  ruleId: string;
  reason: string;
  operationHash: string;
}
