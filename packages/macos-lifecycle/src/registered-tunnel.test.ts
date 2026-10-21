import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';
import { withRegisteredTunnel } from './registered-tunnel.js';
import type { CoreEvidence } from './health-probe.js';
import type { ManagedChild, TunnelCompatibility } from './supervisor.js';
import type { TunnelCustodyPort } from './adapters/native-tunnel.js';
import type { TunnelRegistration } from './tunnel-registration.js';

const releaseDigest='a'.repeat(64);
const config=()=>parseConfig({schemaVersion:1,mode:'LAB_ONLY',runtimeUser:'gram-agent',releaseId:'lab-tunnel',
  releaseDigest,tunnel:{enabled:true,compatibilityDigest:'b'.repeat(64),credentialRef:'test-tunnel-key'}});
const compatibility: TunnelCompatibility=Object.freeze({digest:'b'.repeat(64)});
const core: CoreEvidence=Object.freeze({state:'LOCAL_CORE_HEALTHY',code:'OK',generation:'cg1',releaseDigest,observedAtMs:1});
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
function child(generation='tg1'){return {role:'tunnel' as const,pid:4343,uid:501,startIdentity:'1700000000.9',generation,releaseDigest};}
function fixture(){
  const exit=deferred<undefined>(); const calls:string[]=[]; let current=true;
  const managed:ManagedChild={child:child(),exited:exit.promise};
  const port:TunnelCustodyPort={
    async spawn(){calls.push('spawn');return managed;},
    async current(given){calls.push('current');return current&&given.generation==='tg1';},
    async stop(given){expect(given).toBe(managed);calls.push('stop');exit.resolve(undefined);},
  };
  return {exit,calls,managed,port,setCurrent:(v:boolean)=>{current=v;}};
}
function registration(owner=child()):TunnelRegistration{
  return {schemaVersion:1,role:'tunnel',configDigest:configDigest(config()),executionRevision:1,
    executionToken:'11111111-1111-4111-8111-111111111111',child:owner};
}

describe('tunnel identity publication before exposing managed start',()=>{
  it('publishes the exact managed tunnel before returning and preserves current/stop custody',async()=>{
    const f=fixture();
    const wrapped=withRegisteredTunnel(f.port,{async publish(c,owner){
      expect(c).toEqual(config());expect(owner).toEqual(child());f.calls.push('publish');return registration(owner);
    }});
    const managed=await wrapped.spawn(config(),compatibility,core,'tg1',new AbortController().signal);
    expect(f.calls).toEqual(['spawn','publish']);
    expect(await wrapped.current(managed.child,new AbortController().signal)).toBe(true);
    expect(f.calls).toEqual(['spawn','publish','current']);
    f.setCurrent(false);
    expect(await wrapped.current(managed.child,new AbortController().signal)).toBe(false);
    await wrapped.stop(managed,20000,new AbortController().signal);
    expect(f.calls.at(-1)).toBe('stop');
  });

  it('publication failure stops and confirms the exact child before rejecting',async()=>{
    const f=fixture();
    const wrapped=withRegisteredTunnel(f.port,{async publish(){throw new Error('PRIVATE_IO');}});
    await expect(wrapped.spawn(config(),compatibility,core,'tg1',new AbortController().signal))
      .rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(f.calls).toEqual(['spawn','stop']);
  });

  it('uncertain cleanup keeps startup unresolved until actual exit',async()=>{
    const f=fixture(); f.port.stop=async()=>{f.calls.push('stop');throw new Error('unknown');};
    const wrapped=withRegisteredTunnel(f.port,{async publish(){throw new Error('PRIVATE_IO');}});
    let settled=false;
    const pending=wrapped.spawn(config(),compatibility,core,'tg1',new AbortController().signal)
      .then(()=>{settled=true;},()=>{settled=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(wrapped.spawn(config(),compatibility,core,'tg2',new AbortController().signal))
      .rejects.toThrow(/^TUNNEL_START_FAILED$/);
    f.exit.resolve(undefined); await pending; expect(settled).toBe(true);
  });

  it('does not spawn or publish when already cancelled',async()=>{
    const f=fixture(); const abort=new AbortController();abort.abort();let publishes=0;
    const wrapped=withRegisteredTunnel(f.port,{async publish(){publishes++;return registration();}});
    await expect(wrapped.spawn(config(),compatibility,core,'tg1',abort.signal))
      .rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(f.calls).toEqual([]);expect(publishes).toBe(0);
  });

  it('rejects copied or foreign handles without delegating current/stop',async()=>{
    const f=fixture();
    const wrapped=withRegisteredTunnel(f.port,{async publish(_c,owner){return registration(owner);}});
    const managed=await wrapped.spawn(config(),compatibility,core,'tg1',new AbortController().signal);
    const before=f.calls.length;
    expect(await wrapped.current({...managed.child,generation:'other'},new AbortController().signal)).toBe(false);
    expect(f.calls.length).toBe(before);
    await expect(wrapped.stop({...managed},20000,new AbortController().signal))
      .rejects.toThrow(/^TUNNEL_STOP_UNKNOWN$/);
    expect(f.calls.length).toBe(before);
    f.exit.resolve(undefined); await managed.exited;
  });
});
