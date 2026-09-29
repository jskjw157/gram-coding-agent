import type { AclProbe } from './trusted-files.js';
import type { StateDirectoryPolicy } from './private-record-files.js';

/** Internal deployment scope. Production binds '/' and the fixed application root. */
export interface RuntimeLayout { anchor: string; relative: string; ownerUid: number }
export interface RuntimeDirectories {
  runPolicy: Readonly<StateDirectoryPolicy>;
  verify(): Promise<void>;
}
export async function inspectRuntimeDirectories(_layout: RuntimeLayout, _runtimeUid: number,
  _acl: AclProbe, _signal: AbortSignal): Promise<RuntimeDirectories> {
  throw new Error('NOT_IMPLEMENTED');
}
