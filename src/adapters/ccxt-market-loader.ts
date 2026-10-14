import {withExchangeRequestContext} from './network.js';

interface MarketLoaderClient {
  loadMarkets?:(...args:any[])=>Promise<any>;
  marketsLoading?:Promise<unknown>;
  reloadingMarkets?:boolean;
  timeout?:unknown;
}

const configured=new WeakSet<object>();

/** Release only a rejected CCXT metadata cache; the next ordinary read may load it again. */
export function configureMarketLoadRecovery(client:MarketLoaderClient):void {
  if(configured.has(client)||typeof client.loadMarkets!=='function')return;
  const loadMarkets=client.loadMarkets.bind(client),observed=new WeakSet<Promise<unknown>>();
  client.loadMarkets=(...args:any[])=>{
    // Budget the original shared GET chain when it starts. A later account caller
    // cannot retroactively bound an unscoped metadata promise it merely joins.
    const timeout=Number(client.timeout),budget=Number.isFinite(timeout)&&timeout>0?Math.min(timeout,8000):8000;
    const result=withExchangeRequestContext(client,{deadlineAt:Date.now()+budget},()=>loadMarkets(...args)),loading=client.marketsLoading;
    if(loading&&!observed.has(loading)){
      observed.add(loading);
      // Observe the native loader itself. An outer caller timing out does not
      // prove this shared metadata request settled, and must not release it.
      void loading.then(()=>{},()=>{
        if(client.marketsLoading!==loading)return;
        client.marketsLoading=undefined;client.reloadingMarkets=false;
      });
    }
    return result;
  };
  configured.add(client);
}
