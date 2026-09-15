export type ApprovalStatus = 'PENDING' | 'APPROVED';

export interface ApprovalRecord {
  id: string;
  taskId: string;
  operationHash: string;
  status: ApprovalStatus;
}

export interface ApprovalStore {
  get(id: string): ApprovalRecord | null;
  markApproved(id: string): void;
}

export class ApprovalService {
  constructor(private readonly store: ApprovalStore) {}

  approve(approvalId: string, operationHash: string): void {
    const approval = this.store.get(approvalId);
    if (approval === null) throw new Error('approval not found');
    if (approval.status !== 'PENDING') throw new Error('approval already resolved');
    if (approval.operationHash !== operationHash) throw new Error('approval operation hash mismatch');
    this.store.markApproved(approvalId);
  }
}
