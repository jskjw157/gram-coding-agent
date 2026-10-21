import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreCredentials } from './health-probe.js';
import type { ServiceSessionDeps } from './service-session.js';
import type { ReviewedServiceRuntime } from './adapters/runtime-authority.js';
import { bindReviewedCoreRuntimeAt } from './adapters/runtime-authority.js';
import { fixture } from './test-support/runtime/fixture.js';

const roots:string[]=[];
afterEach(async()=>{for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
const signal=()=>new AbortController().signal;

describe('reviewed service session dependency composition',()=>{
  it('copies the runtime stopped-recovery capability without invoking it during construction',async()=>{
    const f=await fixture();roots.push(f.anchor);
    const runtime=await bindReviewedCoreRuntimeAt(f.layout,f.review,f.acl,f.environment,signal());
    if(!runtime)throw new Error('runtime');
    let calls=0;
    const source:ReviewedServiceRuntime=Object.freeze({
      ...runtime,
      async confirmStopped(role,abort){
        calls++;
        return runtime.confirmStopped(role,abort);
      },
    });
    const credentials:CoreCredentials=Object.freeze({
      async withValue<T>():Promise<T>{throw new Error('credential must not be used');},
    });
    const module=await import('./service-session.js') as unknown as {
      createReviewedServiceSessionDeps?:(
        runtime:ReviewedServiceRuntime,credentials:CoreCredentials
      )=>ServiceSessionDeps;
    };
    expect(module.createReviewedServiceSessionDeps).toBeTypeOf('function');
    if(!module.createReviewedServiceSessionDeps)return;
    const deps=module.createReviewedServiceSessionDeps(source,credentials);
    expect(calls).toBe(0);
    expect(deps.confirmStopped).toBeTypeOf('function');
    expect(await deps.confirmStopped?.('core',signal())).toBe(true);
    expect(calls).toBe(1);
  });

  it('captures method bindings so later caller mutation cannot replace stopped recovery',async()=>{
    const f=await fixture();roots.push(f.anchor);
    const runtime=await bindReviewedCoreRuntimeAt(f.layout,f.review,f.acl,f.environment,signal());
    if(!runtime)throw new Error('runtime');
    let original=0;
    const mutable={...runtime,async confirmStopped(){original++;return true;}} as ReviewedServiceRuntime;
    const credentials:CoreCredentials=Object.freeze({
      async withValue<T>():Promise<T>{throw new Error('credential must not be used');},
    });
    const module=await import('./service-session.js') as unknown as {
      createReviewedServiceSessionDeps?:(
        runtime:ReviewedServiceRuntime,credentials:CoreCredentials
      )=>ServiceSessionDeps;
    };
    expect(module.createReviewedServiceSessionDeps).toBeTypeOf('function');
    if(!module.createReviewedServiceSessionDeps)return;
    const deps=module.createReviewedServiceSessionDeps(mutable,credentials);
    mutable.confirmStopped=async()=>false;
    expect(await deps.confirmStopped?.('core',signal())).toBe(true);
    expect(original).toBe(1);
  });
});
