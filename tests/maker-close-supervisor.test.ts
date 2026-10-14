import test from 'node:test';
import assert from 'node:assert/strict';
import {MakerCloseSupervisor,MAKER_CLOSE_TIMEOUT_MS,MAKER_CLOSE_POLL_MS,type MakerCloseCallbacks} from '../src/core/maker-close-supervisor.js';
import type {MakerReductionObservation,OrderResult} from '../src/shared/types.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function clock(at=0){return {now:()=>at,wait:async(ms:number)=>{at+=ms;},advance:(ms:number)=>{at+=ms;}};}
function result(quantity=0,status:OrderResult['status']='unknown'):OrderResult {
  return {id:'offline-native-maker',clientOrderId:'offline-original-client',status,filledQuantity:quantity,
    averagePrice:quantity?100:0,feeUsd:quantity*.02,timestamp:1};
}
function observation(activity:MakerReductionObservation['activity'],quantity=0,verified=true):MakerReductionObservation {
  return {activity,executionVerified:verified,result:result(quantity,activity==='terminal'?(quantity?'partial':'cancelled'):'unknown'),observedAt:1};
}
function fixture(read:()=>Promise<MakerReductionObservation>){
  const events:string[]=[],observed:MakerReductionObservation[]=[],ack=result();let posts=0,cancels=0,reads=0,finished:string|undefined;
  const callbacks:MakerCloseCallbacks={
    submit:async()=>{posts++;events.push('submit');return ack;},
    acknowledge:async value=>{assert.equal(value,ack);events.push('acknowledge');},
    canRest:async()=>{events.push('can-rest');return true;},
    inspect:async()=>{reads++;events.push('inspect');return read();},
    observe:async value=>{observed.push(value);events.push(`observe:${value.result.filledQuantity}`);
      return {terminal:value.activity==='terminal'&&value.executionVerified};},
    cancel:async()=>{cancels++;events.push('cancel');},
    finish:async reason=>{finished=reason;events.push('finish');},
  };
  return {callbacks,events,observed,ack,posts:()=>posts,cancels:()=>cancels,reads:()=>reads,finished:()=>finished};
}

test('active verified partial is committed and hedged before the next native inspection',async()=>{
  const hedge=deferred<void>(),events:string[]=[],c=clock(),supervisor=new MakerCloseSupervisor(c);let reads=0;
  const f=fixture(async()=>{events.push(`inspect:${++reads}`);return reads===1?observation('active',.2):observation('terminal',.3);});
  f.callbacks.observe=async value=>{
    events.push(`observe:${value.result.filledQuantity}`);
    if(reads===1){assert.equal(value.activity,'active');assert.equal(value.executionVerified,true);
      events.push('hedge-start');await hedge.promise;events.push('hedge-finished');}
    return {terminal:value.activity==='terminal'};
  };
  assert.equal(supervisor.start('position-one',5_000,f.callbacks),true);
  assert.equal(f.posts(),0,'start dispatches outside the caller transaction');
  await flush();assert.deepEqual(events,['inspect:1','observe:0.2','hedge-start']);assert.equal(reads,1);
  hedge.resolve();await supervisor.settled('position-one');
  assert.deepEqual(events,['inspect:1','observe:0.2','hedge-start','hedge-finished','inspect:2','observe:0.3']);
  assert.equal(f.posts(),1);assert.equal(f.cancels(),0);assert.equal(supervisor.has('position-one'),false);
});

test('an ACK reporting a full fill does not establish terminal native activity or trigger the fill callback',async()=>{
  let reads=0;const f=fixture(async()=>++reads===1?observation('active'):observation('terminal',.4));
  Object.assign(f.ack,result(1,'filled'));
  const supervisor=new MakerCloseSupervisor(clock());supervisor.start('ack-only',5_000,f.callbacks);await supervisor.settled('ack-only');
  assert.equal(f.reads(),2);assert.deepEqual(f.observed.map(value=>value.result.filledQuantity),[0,.4]);
  assert.ok(f.events.indexOf('acknowledge')<f.events.indexOf('inspect'));
  assert.ok(f.events.indexOf('finish')>f.events.indexOf('observe:0.4'));assert.equal(f.cancels(),0);
});

test('verified cumulative progress immediately rechecks the original Maker, while zero and duplicate fills retain idle polling',async()=>{
  let at=0,reads=0;const readAt:number[]=[],waits:number[]=[],rows=[observation('active'),observation('active',.2),
    observation('active',.2),observation('active',.3),observation('terminal',.3)];
  const supervisor=new MakerCloseSupervisor({now:()=>at,wait:async ms=>{waits.push(ms);at+=ms;}});
  const f=fixture(async()=>{readAt.push(at);return rows[reads++];});
  supervisor.start('adaptive-progress',5_000,f.callbacks);await supervisor.settled('adaptive-progress');
  assert.deepEqual(readAt,[0,100,100,200,200]);assert.deepEqual(waits,[100,100]);
  assert.deepEqual(f.observed.map(row=>row.result.filledQuantity),[0,.2,.2,.3,.3]);
  assert.equal(f.posts(),1);assert.equal(f.cancels(),0);
});

test('unverified fill quantities cannot remove the polling delay or replace verified cumulative progress',async()=>{
  let at=0,reads=0;const readAt:number[]=[],waits:number[]=[],rows=[observation('active',.8,false),
    observation('active',.2),observation('terminal',.2)];
  const supervisor=new MakerCloseSupervisor({now:()=>at,wait:async ms=>{waits.push(ms);at+=ms;}});
  const f=fixture(async()=>{readAt.push(at);return rows[reads++];});
  supervisor.start('unverified-progress',5_000,f.callbacks);await supervisor.settled('unverified-progress');
  assert.deepEqual(readAt,[0,100,100]);assert.deepEqual(waits,[100]);assert.equal(f.posts(),1);
});

test('a stop reason, unknown observation or failed native read cancels without an idle polling delay',async()=>{
  for(const source of ['stop-reason','unknown','read-failed'] as const){
    let reads=0;const waits:number[]=[],supervisor=new MakerCloseSupervisor({now:()=>0,wait:async ms=>{waits.push(ms);}});
    const f=fixture(async()=>{
      if(++reads===1){if(source==='read-failed')throw new Error('offline original GET failed');
        return observation(source==='unknown'?'unknown':'active',0,source!=='unknown');}
      return observation('terminal',.2);
    });
    if(source==='stop-reason')f.callbacks.observe=async row=>{f.observed.push(row);f.events.push(`observe:${row.result.filledQuantity}`);
      return {terminal:row.activity==='terminal',...(row.activity==='active'?{stopReason:'offline peer needs cancellation'}:{})};};
    supervisor.start(`no-stop-delay-${source}`,5_000,f.callbacks);await supervisor.settled(`no-stop-delay-${source}`);
    assert.deepEqual(waits,[],source);assert.equal(f.posts(),1,source);assert.equal(f.cancels(),1,source);
    assert.ok(f.events.indexOf('cancel')<f.events.lastIndexOf('inspect'),source);
    assert.equal(f.observed.at(-1)!.result.filledQuantity,.2,source);
  }
});

test('explicit stop interrupts an idle poll without waiting for its clock promise',{timeout:1_000},async t=>{
  const idle=deferred<void>(),enteredIdle=deferred<void>(),cancelled=deferred<void>();let reads=0;
  const supervisor=new MakerCloseSupervisor({now:()=>0,wait:()=>{enteredIdle.resolve();return idle.promise;}}),
    f=fixture(async()=>++reads===1?observation('active'):observation('terminal',.2));
  t.after(()=>idle.resolve());f.callbacks.cancel=async()=>{f.events.push('cancel');cancelled.resolve();};
  supervisor.start('idle-stop',5_000,f.callbacks);await enteredIdle.promise;
  supervisor.requestStop('idle-stop','stop during idle polling');await cancelled.promise;await supervisor.settled('idle-stop');
  assert.equal(f.reads(),2);assert.equal(f.posts(),1);assert.equal(f.finished(),'stop during idle polling');
});

test('deadline interrupts an idle poll and accepts the final cancellation-race fill',{timeout:1_000},async t=>{
  const idle=deferred<void>(),enteredIdle=deferred<void>(),cancelled=deferred<void>();let reads=0;
  const supervisor=new MakerCloseSupervisor({now:()=>Date.now(),wait:()=>{enteredIdle.resolve();return idle.promise;}}),
    f=fixture(async()=>++reads===1?observation('active'):observation('terminal',.4));
  t.after(()=>idle.resolve());f.callbacks.cancel=async()=>{f.events.push('cancel');cancelled.resolve();};
  supervisor.start('idle-deadline',Date.now()+20,f.callbacks);await enteredIdle.promise;await cancelled.promise;
  await supervisor.settled('idle-deadline');assert.equal(f.reads(),2);assert.equal(f.posts(),1);
  assert.equal(f.observed.at(-1)!.result.filledQuantity,.4);assert.match(f.finished()!,/5 秒/);
});

test('five-second timeout first cancels the original order then inspects and observes its final receipt',async()=>{
  assert.equal(MAKER_CLOSE_TIMEOUT_MS,5_000);assert.equal(MAKER_CLOSE_POLL_MS,100);
  const c=clock(),supervisor=new MakerCloseSupervisor(c);let cancelled=false;
  const f=fixture(async()=>observation(cancelled?'terminal':'active'));
  f.callbacks.cancel=async()=>{assert.equal(c.now(),MAKER_CLOSE_TIMEOUT_MS);cancelled=true;f.events.push('cancel');};
  supervisor.start('timeout',c.now()+MAKER_CLOSE_TIMEOUT_MS,f.callbacks);await supervisor.settled('timeout');
  assert.equal(f.posts(),1);assert.equal(f.reads(),MAKER_CLOSE_TIMEOUT_MS/MAKER_CLOSE_POLL_MS+1);
  const cancel=f.events.indexOf('cancel');assert.deepEqual(f.events.slice(cancel),['cancel','inspect','observe:0','finish']);
  assert.match(f.finished()!,/5 秒/);assert.equal(c.now(),5_000);
});

test('late fills while cancellation is in flight reach observe and the immediate hedge before another read',async()=>{
  const c=clock(4_900),supervisor=new MakerCloseSupervisor(c),quantities:number[]=[],hedges:number[]=[],events:string[]=[];
  let reads=0,cancelled=false,booked=0;
  const f=fixture(async()=>{
    events.push(`inspect:${++reads}`);
    if(reads===1)return observation('active',.2);
    assert.equal(cancelled,true);return reads===2?observation('active',.6):observation('terminal',.9);
  });
  f.callbacks.cancel=async()=>{cancelled=true;events.push('cancel-ack');};
  f.callbacks.observe=async value=>{quantities.push(value.result.filledQuantity);events.push(`observe:${value.result.filledQuantity}`);
    hedges.push(value.result.filledQuantity-booked);booked=value.result.filledQuantity;events.push(`hedge:${booked}`);
    if(reads===1)c.advance(100); // The confirmed partial's hedge crosses the deadline; no idle delay is needed.
    return {terminal:value.activity==='terminal'};};
  supervisor.start('cancel-race',5_000,f.callbacks);await supervisor.settled('cancel-race');
  assert.deepEqual(quantities,[.2,.6,.9]);assert.equal(hedges.length,3);
  for(const [index,wanted] of [.2,.4,.3].entries())assert.ok(Math.abs(hedges[index]-wanted)<1e-12);
  assert.deepEqual(events,['inspect:1','observe:0.2','hedge:0.2','cancel-ack','inspect:2','observe:0.6','hedge:0.6',
    'inspect:3','observe:0.9','hedge:0.9']);assert.equal(f.posts(),1);
});

test('a cancel ACK followed by three active or unknown reads preserves uncertainty without another POST',async()=>{
  let reads=0;const f=fixture(async()=>++reads===1?observation('unknown',0,false):observation('active',.2));
  const supervisor=new MakerCloseSupervisor(clock());supervisor.start('unknown',5_000,f.callbacks);await supervisor.settled('unknown');
  assert.equal(f.posts(),1);assert.equal(f.cancels(),1);assert.equal(f.reads(),4);assert.equal(f.observed.length,4);
  assert.deepEqual(f.observed.map(value=>value.activity),['unknown','active','active','active']);
  assert.match(f.finished()!,/终态尚未确认/);assert.match(f.finished()!,/禁止重挂/);
  assert.ok(f.events.indexOf('cancel')>f.events.indexOf('observe:0'));
  assert.equal(f.events.filter(value=>value==='finish').length,1);
});

test('native GET exceptions cancel once, use bounded final reads and never retry the submission',async()=>{
  const f=fixture(async()=>{throw new Error('offline native read failure');});
  const supervisor=new MakerCloseSupervisor(clock());supervisor.start('read-failed',5_000,f.callbacks);await supervisor.settled('read-failed');
  assert.equal(f.posts(),1);assert.equal(f.cancels(),1);assert.equal(f.reads(),4);assert.equal(f.observed.length,0);
  assert.ok(f.finished());assert.equal(f.events.at(-1),'finish');
});

test('an ambiguous create exception keeps the original ID for cancellation and inspection without replay',async()=>{
  const f=fixture(async()=>observation('terminal',.4));let posts=0;
  f.callbacks.submit=async()=>{posts++;f.events.push('submit-ambiguous');throw new Error('offline lost create response');};
  f.callbacks.acknowledge=async value=>{assert.equal(value,undefined);f.events.push('acknowledge-unknown');};
  const supervisor=new MakerCloseSupervisor(clock());supervisor.start('create-unknown',5_000,f.callbacks);await supervisor.settled('create-unknown');
  assert.equal(posts,1);assert.equal(f.cancels(),1);assert.equal(f.reads(),1);assert.equal(f.observed[0].result.filledQuantity,.4);
  assert.deepEqual(f.events,['submit-ambiguous','acknowledge-unknown','cancel','inspect','observe:0.4','finish']);
});

test('a failed cancel still requires native final evidence and accepts a late verified fill',async()=>{
  const f=fixture(async()=>observation('terminal',.7));let cancels=0;
  f.callbacks.canRest=async()=>false;
  f.callbacks.cancel=async()=>{cancels++;f.events.push('cancel-failed');throw new Error('offline cancel response lost');};
  const supervisor=new MakerCloseSupervisor(clock());supervisor.start('cancel-failed',5_000,f.callbacks);await supervisor.settled('cancel-failed');
  assert.equal(cancels,1);assert.equal(f.posts(),1);assert.equal(f.observed[0].result.filledQuantity,.7);
  assert.deepEqual(f.events,['submit','acknowledge','cancel-failed','inspect','observe:0.7','finish']);
});

test('observe can stop rest permission after hedging a partial, then cancellation gets the final cumulative fill',async()=>{
  let reads=0;const f=fixture(async()=>++reads===1?observation('active',.2):observation('terminal',.3));
  f.callbacks.observe=async value=>{f.observed.push(value);f.events.push(`observe:${value.result.filledQuantity}`);
    return {terminal:value.activity==='terminal',...(value.activity==='active'?{stopReason:'offline peer IOC could not fully hedge'}:{})};};
  const supervisor=new MakerCloseSupervisor(clock());supervisor.start('hedge-stop',5_000,f.callbacks);await supervisor.settled('hedge-stop');
  assert.equal(f.cancels(),1);assert.equal(f.posts(),1);assert.equal(f.reads(),2);assert.match(f.finished()!,/peer IOC/);
  assert.deepEqual(f.observed.map(value=>value.result.filledQuantity),[.2,.3]);
});

test('callback processing errors request cancellation of the original Maker and finish without another submission',async()=>{
  for(const stage of ['acknowledge','canRest','observe'] as const){
    const f=fixture(async()=>observation('terminal',.3));let threw=false;
    const original=f.callbacks[stage];
    if(stage==='acknowledge')f.callbacks.acknowledge=async value=>{if(!threw){threw=true;throw new Error('offline acknowledge commit failure');}await (original as MakerCloseCallbacks['acknowledge'])(value);};
    else if(stage==='canRest')f.callbacks.canRest=async()=>{if(!threw){threw=true;throw new Error('offline permit read failure');}return true;};
    else f.callbacks.observe=async value=>{if(!threw){threw=true;throw new Error('offline hedge callback failure');}return {terminal:value.activity==='terminal'};};
    const supervisor=new MakerCloseSupervisor(clock());supervisor.start(`callback-${stage}`,5_000,f.callbacks);await supervisor.settled(`callback-${stage}`);
    assert.equal(threw,true);assert.equal(f.posts(),1);assert.equal(f.cancels(),1);assert.match(f.finished()!,/等待核对/);
  }
});

test('another position starts and settles while one native inspection is pending; drain waits for the original final read',async()=>{
  const pending=deferred<MakerReductionObservation>(),final=deferred<MakerReductionObservation>(),c=clock(),supervisor=new MakerCloseSupervisor(c);let reads=0;
  const first=fixture(async()=>++reads===1?pending.promise:final.promise),second=fixture(async()=>observation('terminal',.1));
  assert.equal(supervisor.start('first',5_000,first.callbacks),true);assert.equal(supervisor.start('first',5_000,first.callbacks),false);
  await flush();assert.equal(first.reads(),1);assert.equal(first.finished(),undefined);
  assert.equal(supervisor.start('second',5_000,second.callbacks),true);await supervisor.settled('second');
  assert.equal(second.posts(),1);assert.equal(supervisor.has('first'),true);assert.equal(supervisor.has('second'),false);
  let drained=false;const draining=supervisor.drain().then(()=>{drained=true;});await flush();assert.equal(drained,false);
  assert.equal(first.cancels(),1);pending.resolve(observation('active',.2));await flush();assert.equal(first.observed.length,0,
    'a pure GET completed after its safety race lost cannot publish stale cash');
  final.resolve(observation('terminal',.4));await draining;
  assert.equal(first.cancels(),1);assert.deepEqual(first.observed.map(value=>value.result.filledQuantity),[.4]);
  assert.match(first.finished()!,/软件停止/);assert.equal(supervisor.has('first'),false);assert.equal(drained,true);
  await supervisor.settled('nonexistent');await supervisor.drain();
});

test('explicit stop reason survives later stop requests and cancellation precedes the final original-order read',async()=>{
  const supervisor=new MakerCloseSupervisor(clock()),f=fixture(async()=>observation('terminal',.1));
  supervisor.start('explicit-stop',5_000,f.callbacks);supervisor.requestStop('explicit-stop','first stop reason');
  supervisor.requestStop('explicit-stop','second stop reason');supervisor.requestStop('nonexistent');await supervisor.settled('explicit-stop');
  assert.equal(f.posts(),1);assert.equal(f.cancels(),1);assert.equal(f.finished(),'first stop reason');
  assert.deepEqual(f.events,['submit','acknowledge','cancel','inspect','observe:0.1','finish']);
});

test('deadline cancels the original Maker while a native GET is still pending',{timeout:1_000},async t=>{
  const pending=deferred<MakerReductionObservation>(),cancelled=deferred<void>();let reads=0,cancels=0;
  const supervisor=new MakerCloseSupervisor(),f=fixture(async()=>++reads===1?pending.promise:observation('terminal',.4));
  t.after(()=>pending.resolve(observation('active',.2)));
  f.callbacks.cancel=async()=>{cancels++;f.events.push('cancel');cancelled.resolve();};
  supervisor.start('deadline-in-flight',Date.now()+20,f.callbacks);
  await flush();assert.equal(f.reads(),1);await cancelled.promise;
  assert.equal(cancels,1,'a hung pure GET cannot delay cancel until that GET returns');
  pending.resolve(observation('active',.2));await supervisor.settled('deadline-in-flight');
  assert.equal(f.posts(),1);assert.ok(f.observed.some(value=>value.activity==='terminal'&&value.result.filledQuantity===.4));
  assert.equal(supervisor.has('deadline-in-flight'),false);
});

test('deadline can cancel while the rest-permission callback is pending',{timeout:1_000},async t=>{
  const pending=deferred<boolean>(),cancelled=deferred<void>();let cancels=0;
  const supervisor=new MakerCloseSupervisor(),f=fixture(async()=>observation('terminal',.3));
  t.after(()=>pending.resolve(true));f.callbacks.canRest=()=>pending.promise;
  f.callbacks.cancel=async()=>{cancels++;f.events.push('cancel');cancelled.resolve();};
  supervisor.start('permission-in-flight',Date.now()+20,f.callbacks);await flush();await cancelled.promise;
  assert.equal(cancels,1);pending.resolve(true);await supervisor.settled('permission-in-flight');
  assert.equal(f.posts(),1);assert.equal(f.observed.at(-1)!.result.filledQuantity,.3);
});

test('requestStop and drain cancel during a pending original inspection without waiting for its response',{timeout:1_000},async t=>{
  const pending=deferred<MakerReductionObservation>(),cancelled=deferred<void>();let reads=0,cancels=0;
  const supervisor=new MakerCloseSupervisor(),f=fixture(async()=>++reads===1?pending.promise:observation('terminal',.4));
  t.after(()=>pending.resolve(observation('active',.2)));
  f.callbacks.cancel=async()=>{cancels++;f.events.push('cancel');cancelled.resolve();};
  supervisor.start('stop-in-flight',Date.now()+5_000,f.callbacks);await flush();assert.equal(f.reads(),1);
  const draining=supervisor.drain();await cancelled.promise;
  assert.equal(cancels,1,'stop wakes cancellation independently of the in-flight GET');
  pending.resolve(observation('active',.2));await draining;assert.equal(supervisor.has('stop-in-flight'),false);
  assert.equal(f.posts(),1);assert.ok(f.observed.some(value=>value.activity==='terminal'&&value.result.filledQuantity===.4));
});

test('a processing exception cancels first and a final read still delivers cancellation-race fills to observe',async()=>{
  const events:string[]=[],supervisor=new MakerCloseSupervisor(clock());let reads=0,threw=false;
  const f=fixture(async()=>{events.push(`inspect:${++reads}`);return reads===1?observation('active',.2):observation('terminal',.6);});
  f.callbacks.cancel=async()=>{events.push('cancel');};
  f.callbacks.observe=async value=>{
    events.push(`observe:${value.result.filledQuantity}`);
    if(!threw){threw=true;throw new Error('offline first hedge commit failed');}
    events.push(`final-hedge:${value.result.filledQuantity}`);return {terminal:value.activity==='terminal'};
  };
  supervisor.start('processing-final-read',5_000,f.callbacks);await supervisor.settled('processing-final-read');
  assert.equal(f.posts(),1);assert.deepEqual(events,['inspect:1','observe:0.2','cancel','inspect:2','observe:0.6','final-hedge:0.6']);
});

test('stop during an ambiguous pending submission cancels its original ID once the ACK becomes available',async()=>{
  const pending=deferred<OrderResult>(),supervisor=new MakerCloseSupervisor(clock()),f=fixture(async()=>observation('terminal',.2));let posts=0;
  f.callbacks.submit=async()=>{posts++;f.events.push('submit-pending');return pending.promise;};
  supervisor.start('pending-submit',5_000,f.callbacks);await flush();supervisor.requestStop('pending-submit','stop before create ACK');
  assert.equal(f.cancels(),0,'there is no acknowledged native order yet');pending.resolve(f.ack);
  await supervisor.settled('pending-submit');assert.equal(posts,1);assert.equal(f.cancels(),1);
  assert.deepEqual(f.events,['submit-pending','acknowledge','cancel','inspect','observe:0.2','finish']);
  assert.equal(f.finished(),'stop before create ACK');
});

test('deadline cancellation does not wait for the acknowledged original ID persistence callback',{timeout:1_000},async t=>{
  const pending=deferred<void>(),cancelled=deferred<void>();let cancels=0;
  const supervisor=new MakerCloseSupervisor(),f=fixture(async()=>observation('terminal',.4));
  t.after(()=>pending.resolve());f.callbacks.acknowledge=async ack=>{assert.equal(ack,f.ack);f.events.push('ack-pending');await pending.promise;};
  f.callbacks.cancel=async()=>{cancels++;f.events.push('cancel');cancelled.resolve();};
  supervisor.start('ack-in-flight',Date.now()+20,f.callbacks);await flush();assert.equal(f.reads(),0);
  await cancelled.promise;assert.equal(cancels,1);pending.resolve();await supervisor.settled('ack-in-flight');
  assert.equal(f.posts(),1);assert.equal(f.observed.at(-1)!.result.filledQuantity,.4);
});

test('a rejected finish is reported once and remains observable without an unattended session rejection',async()=>{
  const supervisor=new MakerCloseSupervisor(clock()),f=fixture(async()=>observation('terminal',.3)),error=new Error('offline final save failure');
  let failures=0;
  f.callbacks.finish=async()=>{throw error;};f.callbacks.failed=value=>{assert.equal(value,error);failures++;};
  supervisor.start('finish-failed',5_000,f.callbacks);await assert.rejects(supervisor.settled('finish-failed'),error);
  await flush();assert.equal(failures,1);assert.equal(supervisor.has('finish-failed'),false);
  assert.equal(f.posts(),1);assert.equal(f.reads(),1);assert.equal(f.cancels(),0);
});
