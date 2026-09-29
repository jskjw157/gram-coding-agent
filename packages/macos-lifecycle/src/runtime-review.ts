import type { ServiceConfig } from './contracts.js';
/** Metadata only. An expected digest must be supplied independently. */
export interface RuntimeReview {
  config: ServiceConfig; configDigest: string;
  nodeDigest: string; fileAclDigest: string; peerOwnerDigest: string;
}
export function copyRuntimeReview(_value: unknown): Readonly<RuntimeReview> {
  throw new Error('INVALID_RUNTIME_REVIEW');
}
export function encodeRuntimeReview(_value: unknown): Buffer {
  throw new Error('INVALID_RUNTIME_REVIEW');
}
export function decodeRuntimeReview(_bytes: Buffer, _expectedDigest: string): Readonly<RuntimeReview> | null {
  return null;
}
