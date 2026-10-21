import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from './contracts.js';
import { bindReviewedCoreRuntimeAt, type ReviewedServiceRuntime } from './adapters/runtime-authority.js';
import { fixture } from './test-support/runtime/fixture.js';

const roots:string[]=[];
afterEach(async()=>{for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
const signal=()=>new AbortController().signal;
type RecoverableRuntime=ReviewedServiceRuntime & {
  confirmStopped?: (role:Role,signal:AbortSignal)=>Promise<boolean>;
};

describe('reviewed runtime stopped-recovery composition',()=>{
  it('exposes fail-closed stopped recovery without mutating a FREE Core slot',async()=>{
    const f=await fixture();roots.push(f.anchor);
    const runtime=await bindReviewedCoreRuntimeAt(f.layout,f.review,f.acl,f.environment,signal()) as RecoverableRuntime|null;
    expect(runtime?.confirmStopped).toBeTypeOf('function');
    if(!runtime?.confirmStopped)return;
    expect(await runtime.confirmStopped('core',signal())).toBe(true);
    expect(await runtime.execution.read('core')).toMatchObject({state:'FREE',revision:0});
  });

  it('exposes FREE tunnel recovery only for a reviewed tunnel-enabled runtime',async()=>{
    const f=await fixture({tunnel:true});roots.push(f.anchor);
    const runtime=await bindReviewedCoreRuntimeAt(f.layout,f.review,f.acl,f.environment,signal()) as RecoverableRuntime|null;
    expect(runtime?.confirmStopped).toBeTypeOf('function');
    if(!runtime?.confirmStopped)return;
    expect(await runtime.confirmStopped('tunnel',signal())).toBe(true);
    expect(await runtime.execution.read('tunnel')).toMatchObject({state:'FREE',revision:0});
  });

  it('keeps a HELD Core when native stopped evidence cannot be established',async()=>{
    const f=await fixture();roots.push(f.anchor);
    const runtime=await bindReviewedCoreRuntimeAt(f.layout,f.review,f.acl,f.environment,signal()) as RecoverableRuntime|null;
    if(!runtime?.confirmStopped)throw new Error('missing recovery');
    await runtime.execution.acquire('core','g1',f.review.configDigest,f.review.config.releaseDigest);
    expect(await runtime.confirmStopped('core',signal())).toBe(false);
    expect(await runtime.execution.read('core')).toMatchObject({state:'HELD',revision:1,generation:'g1'});
  });

  it('refuses tunnel recovery for a core-only reviewed runtime',async()=>{
    const f=await fixture();roots.push(f.anchor);
    const runtime=await bindReviewedCoreRuntimeAt(f.layout,f.review,f.acl,f.environment,signal()) as RecoverableRuntime|null;
    if(!runtime?.confirmStopped)throw new Error('missing recovery');
    expect(await runtime.confirmStopped('tunnel',signal())).toBe(false);
  });
});
