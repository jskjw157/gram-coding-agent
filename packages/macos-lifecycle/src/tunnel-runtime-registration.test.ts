import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import type { CoreEvidence } from './health-probe.js';
import { createReviewedTunnelCustody, type ReviewedTunnelCustodyRuntime } from './tunnel-runtime.js';
import { TunnelRegistrationStore } from './tunnel-registration.js';
import { MemoryExecutionFiles } from './test-support/execution-fixture.js';
import type { RecordFiles } from './telemetry-store.js';
import type { NativePeerProofPort } from './adapters/owned-process.js';

const releaseDigest='a'.repeat(64);
const config=parseConfig({schemaVersion:1,mode:'LAB_ONLY',runtimeUser:'gram-agent',releaseId:'lab-tunnel',
  releaseDigest,tunnel:{enabled:true,compatibilityDigest:'b'.repeat(64),credentialRef:'test-tunnel-key'}});
const core:CoreEvidence=Object.freeze({state:'LOCAL_CORE_HEALTHY',code:'OK',generation:'cg1',releaseDigest,observedAtMs:1});

class MemoryRecords implements RecordFiles {
  bytes:Buffer|null=null; digest:string|null=null;
  async read(){return [this.bytes?Buffer.from(this.bytes):null];}
  async compareAndSwap(_role:'core'|'tunnel',expected:readonly(string|null)[],slot:number,bytes:Buffer){
    if(slot!==0||expected.length!==1||expected[0]!==this.digest)throw new Error('STATE_CONFLICT');
    const {createHash}=await import('node:crypto');
    this.bytes=Buffer.from(bytes);this.digest=createHash('sha256').update(bytes).digest('hex');
  }
}

describe('reviewed tunnel custody registration composition',()=>{
  it('publishes tunnel registration before returning a successful managed child',async()=>{
    const executionFiles=new MemoryExecutionFiles();const execution=new ExecutionLeaseStore(executionFiles);
    await execution.initializeNew('tunnel');
    const records=new MemoryRecords();const tunnelRegistration=new TunnelRegistrationStore(records,execution);
    const proof:NativePeerProofPort=Object.freeze({
      async capture(){return {sec:'1700000000',usec:'9'};},
      async current(){return 'OWNED';},async peer(){return 'UNKNOWN';},
    });
    const runtime:ReviewedTunnelCustodyRuntime={
      configuration:config,execution,tunnelRegistration,
      tunnelRuntime:{compatibility:Object.freeze({digest:'b'.repeat(64)}),authority:{
        async acquire(){
          return {configDigest:configDigest(config),compatibilityDigest:'b'.repeat(64),
            account:{name:'gram-agent',uid:process.getuid?.()??501,gid:process.getgid?.()??20,admin:false},
            executable:{dev:11n,ino:22n},proof};
        },
      }},
    };
    const custody=createReviewedTunnelCustody(runtime,()=>spawn(process.execPath,['-e',
      "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);"
    ],{stdio:['ignore','pipe','pipe']}));
    expect(custody).not.toBeNull();
    if(!custody)return;
    const managed=await custody.spawn(config,{digest:'b'.repeat(64)},core,'tg1',new AbortController().signal);
    expect(await tunnelRegistration.read()).toMatchObject({
      role:'tunnel',configDigest:configDigest(config),executionRevision:1,
      child:{generation:'tg1',pid:managed.child.pid,startIdentity:managed.child.startIdentity},
    });
    await custody.stop(managed,20000,new AbortController().signal);
    await managed.exited;
  },5000);

  it('refuses enabled tunnel composition when durable registration is absent',async()=>{
    const executionFiles=new MemoryExecutionFiles();const execution=new ExecutionLeaseStore(executionFiles);
    await execution.initializeNew('tunnel');
    const runtime={configuration:config,execution,tunnelRegistration:null,tunnelRuntime:{
      compatibility:Object.freeze({digest:'b'.repeat(64)}),authority:{async acquire(){return null;}},
    }} as ReviewedTunnelCustodyRuntime;
    expect(createReviewedTunnelCustody(runtime,()=>{throw new Error('must not launch');})).toBeNull();
  });
});
