import {AsyncLocalStorage} from 'node:async_hooks';

export interface CcxtReadThrottleOptions {
  getContext:()=>{deadlineAt?:number;signal?:AbortSignal}|undefined;
  timeoutError:()=>Error;
}

interface PendingPermit {owner:any;entry:any;resolver:Function;cost:number}
const installed=new WeakMap<object,{options:CcxtReadThrottleOptions}>();
const maximumTimerDelay=2147483647;

function activeQueue(owner:any):any[]|undefined{
  if(!owner||!Array.isArray(owner.queue)||!Number.isInteger(owner.queueHead)||owner.queueHead<0||owner.queueHead>owner.queue.length)return;
  return owner.queue.slice(owner.queueHead);
}
function pendingPermit(client:any,owner:any,before:ReadonlySet<any>|undefined):PendingPermit|undefined{
  if(!before||client.throttler!==owner)return;
  const queue=activeQueue(owner);if(!queue)return;
  const added=queue.filter(entry=>entry&&!before.has(entry));if(added.length!==1)return;
  const entry=added[0],resolver=Object.getOwnPropertyDescriptor(entry,'resolver'),cost=Object.getOwnPropertyDescriptor(entry,'cost');
  // Only the installed native queue's plain, writable unadmitted item is cancellable.
  if(!resolver||typeof resolver.value!=='function'||!cost||cost.writable!==true||!Number.isFinite(cost.value)||cost.value<0)return;
  return {owner,entry,resolver:resolver.value,cost:cost.value};
}
function cancelPermit(client:any,permit:PendingPermit):boolean{
  if(client.throttler!==permit.owner)return false;
  const queue=activeQueue(permit.owner);if(!queue||queue.filter(entry=>entry===permit.entry).length!==1)return false;
  const resolver=Object.getOwnPropertyDescriptor(permit.entry,'resolver'),cost=Object.getOwnPropertyDescriptor(permit.entry,'cost');
  if(resolver?.value!==permit.resolver||!cost||cost.writable!==true||cost.value!==permit.cost)return false;
  // Keep the native FIFO slot/resolver. Its eventual admission consumes no request cost
  // and resolves only the observed native promise, never the rejected GET continuation.
  permit.entry.cost=0;return true;
}

/** Cancel only a proven, not-yet-admitted GET permit under its existing read budget. */
export function configureCcxtReadThrottle(client:any,options:CcxtReadThrottleOptions):void{
  if(!client||typeof client!=='object')return;
  const existing=installed.get(client);if(existing){existing.options=options;return;}
  if(typeof client.fetch2!=='function'||typeof client.throttle!=='function')return;
  const state={options};
  const originalFetch2=client.fetch2,originalThrottle=client.throttle,method=new AsyncLocalStorage<boolean>();
  client.fetch2=function(this:any,...args:any[]){
    if(this!==client)return originalFetch2.apply(this,args);
    const verb=args[2]===undefined?'GET':args[2];
    return method.run(typeof verb==='string'&&verb.toUpperCase()==='GET',()=>originalFetch2.apply(this,args));
  };
  client.throttle=function(this:any,...args:any[]){
    if(this!==client||method.getStore()!==true)return originalThrottle.apply(this,args);
    const hooks=state.options,context=hooks.getContext(),deadlineAt=Number.isFinite(context?.deadlineAt)?context!.deadlineAt:undefined,
      signal=context?.signal;
    if(deadlineAt===undefined&&!signal)return originalThrottle.apply(this,args);
    const expired=()=>signal?.aborted===true||(deadlineAt!==undefined&&Date.now()>=deadlineAt);
    const timeoutError=()=>{try{return hooks.timeoutError();}catch(error){return error;}};
    if(expired())return Promise.reject(timeoutError());
    const owner=client.throttler,beforeQueue=activeQueue(owner),before=beforeQueue?new Set(beforeQueue):undefined;
    let native:any;
    try{native=originalThrottle.apply(this,args);}catch(error){return Promise.reject(error);}
    const permit=pendingPermit(client,owner,before);
    return new Promise((resolve,reject)=>{
      let done=false,timer:ReturnType<typeof setTimeout>|undefined;
      const clean=()=>{if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
      const finish=(failed:boolean,value:unknown)=>{if(done)return;done=true;clean();if(failed)reject(value);else resolve(value);};
      const cancel=()=>{if(!done&&expired()&&permit&&cancelPermit(client,permit))finish(true,timeoutError());};
      const schedule=()=>{
        if(done||!permit||deadlineAt===undefined)return;
        const remaining=deadlineAt-Date.now();
        if(remaining<=0){cancel();return;}
        timer=setTimeout(()=>{timer=undefined;if(expired())cancel();else schedule();},Math.min(maximumTimerDelay,Math.max(1,remaining)));
      };
      // Both handlers remain attached after cancellation to observe native late settlement.
      Promise.resolve(native).then(value=>expired()?finish(true,timeoutError()):finish(false,value),error=>finish(true,expired()?timeoutError():error));
      if(permit){signal?.addEventListener('abort',cancel,{once:true});if(expired())cancel();else schedule();}
    });
  };
  installed.set(client,state);
}
