interface WsSendObserver {
  isCurrent:()=>boolean;
  onFailure:()=>void;
}
interface InstalledObserver {observer:WsSendObserver;generation:number}
const exchanges=new WeakMap<object,InstalledObserver>();
const nativeClients=new WeakMap<object,{failed:boolean;send:(...args:any[])=>unknown}>();

/** CCXT's throttled watch branch can discard the native send promise. Observe its rejection
 * without replacing its result, replaying the payload, or changing subscription throttling. */
export function observeWsSendRejections(exchange:any,observer:WsSendObserver):void {
  if(!exchange||typeof exchange.client!=='function')return;
  const installed=exchanges.get(exchange);
  if(installed){installed.observer=observer;installed.generation++;return;}
  const state:InstalledObserver={observer,generation:1};
  exchanges.set(exchange,state);
  const client=exchange.client;
  exchange.client=function(...args:any[]){
    const native=client.apply(this,args);
    if(!native||typeof native.send!=='function'||nativeClients.has(native))return native;
    const original=native.send;
    const guarded={failed:false,send:original};nativeClients.set(native,guarded);
    native.send=function(...sendArgs:any[]){
      // Capture the owner of this actual send, so an old pending rejection cannot invalidate a replacement.
      const owner=state.observer,generation=state.generation;
      const failed=(error:unknown)=>{
        if(guarded.failed||state.generation!==generation)return;
        let current=false;try{current=owner.isCurrent();}catch{/* A failed ownership check never authorizes invalidation. */}
        if(!current)return;
        guarded.failed=true;
        try{
          if(typeof native.onError==='function')native.onError(error);
          else owner.onFailure();
        }catch{
          // A native callback failure must not create a second unattended rejection.
          try{owner.onFailure();}catch{/* Existing cache invalidation remains the owner's responsibility. */}
        }
      };
      let promise:any;
      try{promise=guarded.send.apply(this,sendArgs);}catch(error){failed(error);throw error;}
      if(promise&&typeof promise.then==='function'){
        // Return the original promise unchanged. Direct callers still receive the real send rejection.
        void Promise.resolve(promise).then(()=>{if(state.generation===generation)guarded.failed=false;},failed);
      }
      return promise;
    };
    return native;
  };
}
