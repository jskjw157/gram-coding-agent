export type FailureClass =
  | 'TRANSIENT'
  | 'CODE_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'POLICY_BLOCK'
  | 'EXTERNAL_FAILURE'
  | 'UNKNOWN';

export interface FailureClassifierPort {
  classify(error: unknown): FailureClass;
}
