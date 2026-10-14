import {performance} from 'node:perf_hooks';
import type {ExchangeId} from '../shared/types.js';
import {assertExchangeRequestActive,classifyNetworkError,exchangeApiCode,withExchangeRequestContext} from './network.js';

const installed=new WeakSet<object>();
const MAX_SAMPLE_MS=4000,MAX_WALL_CHANGE_MS=250,FAILURE_COOLDOWN_MS=15000;

/** Recover only a rejected signed read. Re-enter fetch2 so CCXT generates a new
 * timestamp and HMAC; repeating an already signed transport URL cannot fix skew.
 * Financial requests remain untouched, including their error/unknown semantics. */
export function configureExchangeClock(client:any,id:ExchangeId):void {
  if(!['binance','bybit'].includes(id)||installed.has(client)||typeof client.fetch2!=='function'||
    typeof client.fetchTime!=='function')return;
  installed.add(client);
  const original=client.fetch2.bind(client);
  const now=()=>typeof client.milliseconds==='function'?client.milliseconds():Date.now();
  let revision=0,failedUntil=-Infinity,pending:Promise<void>|undefined;
  const synchronize=():Promise<void>=>{
    if(pending)return pending;
    if(performance.now()<failedUntil)return Promise.reject(new Error('Exchange clock calibration is cooling down'));
    const task=(async()=>{
      const before=now(),started=performance.now();
      const serverTime=await withExchangeRequestContext<number>(client,{deadlineAt:Date.now()+6000},()=>client.fetchTime());
      const after=now(),elapsed=performance.now()-started;
      // Use the same response-time convention as CCXT loadTimeDifference. A slow
      // sample or an OS clock step during the read cannot establish a safe offset.
      if(![before,after,serverTime].every(value=>Number.isSafeInteger(value)&&value>0)||
        elapsed<0||elapsed>MAX_SAMPLE_MS||Math.abs((after-before)-elapsed)>MAX_WALL_CHANGE_MS)
        throw new Error('Exchange clock calibration sample is invalid');
      const difference=after-serverTime;
      if(!Number.isSafeInteger(difference))throw new Error('Exchange clock calibration offset is invalid');
      client.options={...client.options,timeDifference:difference};revision++;failedUntil=-Infinity;
    })();
    pending=task.catch(error=>{failedUntil=performance.now()+FAILURE_COOLDOWN_MS;throw error;})
      .finally(()=>{pending=undefined;});
    return pending;
  };
  client.fetch2=async(path:string,api:unknown='public',method='GET',...rest:any[])=>{
    const privateRead=method.toUpperCase()==='GET'&&(id==='bybit'?api==='private':
      typeof api==='string'&&/^fapiPrivate(?:V[23])?$/.test(api));
    // An explicitly supplied timestamp overrides CCXT's nonce; preserve that
    // caller's contract rather than replaying a value calibration cannot repair.
    const params=rest[0];
    if(!privateRead||params&&typeof params==='object'&&Object.hasOwn(params,'timestamp'))return original(path,api,method,...rest);
    const timeout=Number(client.timeout),budget=Number.isFinite(timeout)&&timeout>0?Math.min(timeout,30000):8000;
    return withExchangeRequestContext(client,{deadlineAt:Date.now()+budget},async()=>{
      assertExchangeRequestActive(client,id);
      const observedRevision=revision;
      try{return await original(path,api,method,...rest);}
      catch(error){
        if(classifyNetworkError(error)!=='API_ERROR'||exchangeApiCode(id,error)!==(id==='binance'?'-1021':'10002'))throw error;
        try{
          // Concurrent reads can fail using the old offset after another has already
          // corrected it. Reuse that observation instead of starting another time GET.
          if(revision===observedRevision)await synchronize();
        }catch{throw error;} // Retain the original sanitized business diagnostic.
        assertExchangeRequestActive(client,id);
        return original(path,api,method,...rest); // exactly one fresh signature; never recurse
      }
    });
  };
}
