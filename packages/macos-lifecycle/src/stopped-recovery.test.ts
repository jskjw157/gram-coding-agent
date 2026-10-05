import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';
import { CoreRegistrationStore } from './core-registration.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import { createStoppedProof, createStoppedRecovery } from './stopped-recovery.js';
import { TunnelRegistrationStore } from './tunnel-registration.js';
import type { NativePeerProofPort, PeerVerdict } from './adapters/owned-process.js';
import { MemoryExecutionFiles, releaseDigest } from './test-support/execution-fixture.js';

const config=parseConfig({schemaVersion:1,mode:'LAB_ONLY',runtimeUser:'gram-agent',releaseId:'lab-recovery',
  releaseDigest,tunnel:{enabled:true,compatibilityDigest:'b'.repeat(64),credentialRef:'test-tunnel-key'}});
const digest=configDigest(config);
const child=(role:'core'|'tunnel',generation:string)=>({
  role,pid:4242,uid:501,startIdentity:'1700000000.7',generation,releaseDigest,
});

async function fixture(role:'core'|'tunnel', verdict:PeerVerdict='FOREIGN'){
  const execFiles=new MemoryExecutionFiles();const execution=new ExecutionLeaseStore(execFiles);
  await execution.initializeNew(role);
  const registrations=new MemoryExecutionFiles();
  const coreRegistration=new CoreRegistrationStore(registrations,execution);
  const tunnelRegistration=new TunnelRegistrationStore(registrations,execution);
  let currentCalls=0;
  const proof:NativePeerProofPort=Object.freeze({
    async capture(){return null;},
    async current(request){currentCalls++;expect(request).toMatchObject({
      pid:4242,uid:501,startSec:'1700000000',startUsec:'7',executable:{dev:11n,ino:22n},
    });return verdict;},
    async peer(){return 'UNKNOWN';},
  });
  const deps={
    config,execution,coreRegistration,tunnelRegistration,proof,
    async executable(candidate:'core'|'tunnel'){
      expect(candidate).toBe(role);return Object.freeze({dev:11n,ino:22n});
    },
  };
  const prove=createStoppedProof(deps);
  const recover=createStoppedRecovery(deps);
  return {execution,coreRegistration,tunnelRegistration,prove,recover,currentCalls:()=>currentCalls};
}

describe('exact stopped execution recovery',()=>{
  it('accepts a FREE execution record without native process inference',async()=>{
    const f=await fixture('core','OWNED');
    expect(await f.recover('core',new AbortController().signal)).toBe(true);
    expect(f.currentCalls()).toBe(0);
    expect(await f.execution.read('core')).toMatchObject({state:'FREE',revision:0});
  });

  it('proves an exact held Core stopped without mutating HELD/revision evidence',async()=>{
    const f=await fixture('core','FOREIGN');
    await f.execution.acquire('core','cg1',digest,releaseDigest);
    await f.coreRegistration.publish(config,child('core','cg1'));
    const before=await f.execution.read('core');
    expect(await f.prove('core',new AbortController().signal)).toBe(true);
    expect(f.currentCalls()).toBe(1);
    expect(await f.execution.read('core')).toEqual(before);
  });

  it('read-only stopped proof refuses OWNED native evidence and preserves HELD',async()=>{
    const f=await fixture('core','OWNED');
    await f.execution.acquire('core','cg1',digest,releaseDigest);
    await f.coreRegistration.publish(config,child('core','cg1'));
    expect(await f.prove('core',new AbortController().signal)).toBe(false);
    expect(await f.execution.read('core')).toMatchObject({state:'HELD',revision:1,generation:'cg1'});
  });

  it('recovers an exact held Core only after native FOREIGN proof',async()=>{
    const f=await fixture('core','FOREIGN');
    await f.execution.acquire('core','cg1',digest,releaseDigest);
    await f.coreRegistration.publish(config,child('core','cg1'));
    expect(await f.recover('core',new AbortController().signal)).toBe(true);
    expect(f.currentCalls()).toBe(1);
    expect(await f.execution.read('core')).toMatchObject({state:'FREE',revision:2,generation:'cg1'});
  });

  it.each(['OWNED','UNKNOWN'] as const)('keeps a held Core for %s native evidence',async verdict=>{
    const f=await fixture('core',verdict);
    await f.execution.acquire('core','cg1',digest,releaseDigest);
    await f.coreRegistration.publish(config,child('core','cg1'));
    expect(await f.recover('core',new AbortController().signal)).toBe(false);
    expect(await f.execution.read('core')).toMatchObject({state:'HELD',revision:1,generation:'cg1'});
  });

  it('recovers an exact held Tunnel only after native FOREIGN proof',async()=>{
    const f=await fixture('tunnel','FOREIGN');
    await f.execution.acquire('tunnel','tg1',digest,releaseDigest);
    await f.tunnelRegistration.publish(config,child('tunnel','tg1'));
    expect(await f.recover('tunnel',new AbortController().signal)).toBe(true);
    expect(await f.execution.read('tunnel')).toMatchObject({state:'FREE',revision:2,generation:'tg1'});
  });

  it('refuses missing or mismatched registration without native proof',async()=>{
    const f=await fixture('tunnel','FOREIGN');
    await f.execution.acquire('tunnel','tg1',digest,releaseDigest);
    expect(await f.recover('tunnel',new AbortController().signal)).toBe(false);
    expect(f.currentCalls()).toBe(0);
    expect(await f.execution.read('tunnel')).toMatchObject({state:'HELD',revision:1});
  });

  it('does not let stale stopped proof overwrite a newer execution owner',async()=>{
    const f=await fixture('core','FOREIGN');
    const old=await f.execution.acquire('core','cg1',digest,releaseDigest);
    await f.coreRegistration.publish(config,child('core','cg1'));
    const original=f.recover;
    let switched=false;
    const proof:NativePeerProofPort=Object.freeze({
      async capture(){return null;},
      async current(){
        if(!switched){
          switched=true;
          await f.execution.release(old);
          await f.execution.acquire('core','cg2',digest,releaseDigest);
        }
        return 'FOREIGN';
      },
      async peer(){return 'UNKNOWN';},
    });
    const recovery=createStoppedRecovery({
      config,execution:f.execution,coreRegistration:f.coreRegistration,tunnelRegistration:f.tunnelRegistration,proof,
      async executable(){return {dev:11n,ino:22n};},
    });
    void original;
    expect(await recovery('core',new AbortController().signal)).toBe(false);
    expect(await f.execution.read('core')).toMatchObject({state:'HELD',revision:3,generation:'cg2'});
  });

  it('fails closed for missing executable identity or cancellation',async()=>{
    const f=await fixture('core','FOREIGN');
    await f.execution.acquire('core','cg1',digest,releaseDigest);
    await f.coreRegistration.publish(config,child('core','cg1'));
    const noExecutable=createStoppedRecovery({
      config,execution:f.execution,coreRegistration:f.coreRegistration,tunnelRegistration:f.tunnelRegistration,
      proof:Object.freeze({async capture(){return null;},async current(){throw new Error('must not run');},async peer(){return 'UNKNOWN';}}),
      async executable(){return null;},
    });
    expect(await noExecutable('core',new AbortController().signal)).toBe(false);
    const abort=new AbortController();abort.abort();
    expect(await f.recover('core',abort.signal)).toBe(false);
    expect(await f.execution.read('core')).toMatchObject({state:'HELD',revision:1});
  });
});
