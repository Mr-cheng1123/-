import type {AccountPosition,ExchangeId,TradingFeeMetadata,TradingFeeReference} from '../shared/types.js';

export const NATIVE_FEE_REFRESH_MS=60_000,NATIVE_FEE_RETRY_MS=15_000,NATIVE_FEE_MAX_AGE_MS=120_000;
const MAX_SYMBOLS=256,CONCURRENCY=2;
function numeric(value:unknown):number{return typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;}
function expense(value:unknown):number|undefined{const rate=numeric(value);return Number.isFinite(rate)&&rate>=0&&rate<=.01?rate:undefined;}
function makerExpense(value:unknown):number|undefined{const rate=numeric(value);return Number.isFinite(rate)&&Math.abs(rate)<=.01?rate:undefined;}
export interface NativeTradingFeeRates {takerFeeRate:number;makerFeeRate?:number}
function rates(taker:unknown,maker:unknown,reverseSign=false):NativeTradingFeeRates|undefined{
  const takerFeeRate=expense(reverseSign?-numeric(taker):taker);
  if(takerFeeRate===undefined)return;
  const makerFeeRate=makerExpense(reverseSign?-numeric(maker):maker);
  return makerFeeRate===undefined?{takerFeeRate}:{takerFeeRate,makerFeeRate};
}

/** Native signed GETs only. Public contract defaults and CCXT generic fee fallback are deliberately excluded. */
export async function readNativeTradingFee(id:ExchangeId,client:any,market:any):Promise<number|undefined>{
  return (await readNativeTradingFeeRates(id,client,market))?.takerFeeRate;
}

/** Both rates come from the same official account response for the exact contract. Missing Maker stays unknown. */
export async function readNativeTradingFeeRates(id:ExchangeId,client:any,market:any):Promise<NativeTradingFeeRates|undefined>{
  const symbol=market.id;
  if(typeof symbol!=='string'||!symbol||!market.swap||!market.linear||market.settle!=='USDT')return;
  if(id==='bybit'){
    if(typeof client.privateGetV5AccountFeeRate!=='function')return;
    const response=await client.privateGetV5AccountFeeRate({category:'linear',symbol});
    if(numeric(response?.retCode)!==0||response?.result?.category!==undefined&&response.result.category!=='linear'||!Array.isArray(response?.result?.list))return;
    const rows=response.result.list.filter((row:any)=>row?.symbol===symbol);
    return rows.length===1?rates(rows[0].takerFeeRate,rows[0].makerFeeRate):undefined;
  }
  if(id==='gate'){
    if(typeof client.privateFuturesGetSettleFee!=='function')return;
    const response=await client.privateFuturesGetSettleFee({settle:'usdt',contract:symbol});
    return response&&Object.hasOwn(response,symbol)?rates(response[symbol]?.taker_fee,response[symbol]?.maker_fee):undefined;
  }
  if(id==='binance'){
    if(typeof client.fapiPrivateGetCommissionRate!=='function')return;
    const response=await client.fapiPrivateGetCommissionRate({symbol});
    return response?.symbol===symbol?rates(response.takerCommissionRate,response.makerCommissionRate):undefined;
  }
  if(id==='bitget'){
    // Never fall back to classic after an unknown/failed UTA account type read.
    if(typeof client.privateUtaGetV3AccountSettings!=='function')return;
    const settings=await client.privateUtaGetV3AccountSettings({});
    if(settings?.code!=='00000')return;
    const mode=settings.data?.accountMode;
    // Current v3 endpoint echoes contract identity. A failed response must not fall back to a generic/base rate.
    if(mode==='unified'&&typeof client.privateUtaGetV3AccountAllFeeRate==='function'){
      const response=await client.privateUtaGetV3AccountAllFeeRate({category:'USDT-FUTURES',symbol});
      if(response?.code!=='00000'||!Array.isArray(response.data))return;
      const rows=response.data.filter((row:any)=>row?.symbol===symbol);
      if(rows.length!==1||rows[0].category!==undefined&&rows[0].category!=='USDT-FUTURES')return;
      return rates(rows[0].takerFeeRate,rows[0].makerFeeRate);
    }
    const response=mode==='unified'&&typeof client.privateUtaGetV3AccountFeeRate==='function'
      ?await client.privateUtaGetV3AccountFeeRate({category:'USDT-FUTURES',symbol})
      :mode==='hybrid'&&typeof client.privateCommonGetV2CommonTradeRate==='function'
        ?await client.privateCommonGetV2CommonTradeRate({businessType:'mix',symbol}):undefined;
    const data=response?.data;
    if(response?.code!=='00000'||!data||data.symbol!==undefined&&data.symbol!==symbol||data.category!==undefined&&data.category!=='USDT-FUTURES')return;
    return rates(data.takerFeeRate,data.makerFeeRate);
  }
  if(id==='okx'){
    if(typeof client.privateGetAccountTradeFee!=='function')return;
    const instFamily=market.info?.instFamily??`${market.baseId??market.base}-${market.quoteId??market.quote}`;
    if(typeof instFamily!=='string'||!instFamily.endsWith('-USDT'))return;
    const response=await client.privateGetAccountTradeFee({instType:'SWAP',instFamily});
    if(response?.code!=='0'||!Array.isArray(response.data)||response.data.length!==1)return;
    const row=response.data[0];
    if(row?.instType!=='SWAP'||row.instFamily!==undefined&&row.instFamily!==instFamily)return;
    // New feeGroup rates are authoritative only with the exact market's native group identity.
    let value:unknown,maker:unknown;
    if(Array.isArray(row.feeGroup)&&row.feeGroup.length){
      const groupId=market.info?.groupId;
      if((typeof groupId!=='string'&&typeof groupId!=='number')||!/^\d+$/.test(String(groupId)))return;
      const groups=row.feeGroup.filter((g:any)=>g&&(typeof g.groupId==='string'||typeof g.groupId==='number')&&String(g.groupId)===String(groupId));
      if(groups.length!==1)return;
      value=groups[0].taker;
      maker=groups[0].maker;
    }else {
      value=row.takerU!==undefined&&row.takerU!==''?row.takerU:row.taker;
      maker=row.makerU!==undefined&&row.makerU!==''?row.makerU:row.maker;
    }
    // OKX negative means expense, positive rebate. Unsupported rebates stay unknown, never abs().
    return rates(value,maker,true);
  }
}

interface Entry {retryAt:number;value?:TradingFeeMetadata;pending?:Promise<TradingFeeMetadata|undefined>}
interface Queued {symbol:string;entry:Entry;resolve:(fee:TradingFeeMetadata|undefined)=>void}

interface Options {reference?:(symbol:string)=>TradingFeeReference|undefined;onObservation?:(symbol:string,fee:TradingFeeMetadata)=>void}

/** Private fees are fetched only for an explicit action; position polling only reads existing evidence. */
export class NativeTradingFees {
  private entries=new Map<string,Entry>();private queue:Queued[]=[];private running=0;private stopped=false;
  constructor(private id:ExchangeId,private client:any,private market:(symbol:string)=>any,private now:()=>number=Date.now,private timeoutMs=6000,private options:Options={}){}
  cached(symbol:string):TradingFeeMetadata|undefined{
    const value=this.entries.get(symbol)?.value,now=this.now();
    return value&&value.takerFeeAt<=now&&now-value.takerFeeAt<=NATIVE_FEE_MAX_AGE_MS?{...value}:undefined;
  }
  fetch(symbol:string):Promise<TradingFeeMetadata|undefined>{
    if(this.stopped)return Promise.resolve(undefined);
    let entry=this.entries.get(symbol);const now=this.now();
    if(entry&&!entry.pending&&now<entry.retryAt)return Promise.resolve(this.cached(symbol));
    if(!entry){
      // Bounded cache and queue. Evict only idle entries; never duplicate a still-running GET.
      if(this.entries.size>=MAX_SYMBOLS){const idle=[...this.entries].find(([,e])=>!e.pending);if(!idle)return Promise.resolve(undefined);this.entries.delete(idle[0]);}
      entry={retryAt:now};this.entries.set(symbol,entry);
    }
    if(!entry.pending){
      const queued=entry;
      entry.pending=new Promise(resolve=>this.queue.push({symbol,entry:queued,resolve}));this.drain();
    }
    const pending=entry.pending!;
    return new Promise(resolve=>{const timer=setTimeout(()=>resolve(this.cached(symbol)),this.timeoutMs);
      void pending.then(value=>{clearTimeout(timer);resolve(value);});});
  }
  enrich(positions:AccountPosition[]):AccountPosition[]{
    // Account rows cannot carry forward expired or unidentified native evidence.
    // A saved reference is explicitly separate from the fresh signed-GET cache.
    return positions.map(p=>{
      const {takerFeeRate:_takerFeeRate,takerFeeAt:_takerFeeAt,takerFeeSource:_takerFeeSource,
        makerFeeRate:_makerFeeRate,makerFeeAt:_makerFeeAt,makerFeeSource:_makerFeeSource,feeReference:_feeReference,...position}=p;
      let feeReference:TradingFeeReference|undefined;
      try{feeReference=this.options.reference?.(p.symbol);}catch{/* Optional display references cannot fail a position read. */}
      return {...position,...this.cached(p.symbol),...(feeReference?{feeReference}:{})};
    });
  }
  private drain(){
    while(!this.stopped&&this.running<CONCURRENCY&&this.queue.length){
      const task=this.queue.shift()!;this.running++;const requestedAt=this.now();let succeeded=false;
      void Promise.resolve().then(()=>readNativeTradingFeeRates(this.id,this.client,this.market(task.symbol))).then(fees=>{
        const now=this.now();if(!this.stopped&&fees!==undefined&&requestedAt<=now&&now-requestedAt<=NATIVE_FEE_MAX_AGE_MS){
          task.entry.value={takerFeeRate:fees.takerFeeRate,takerFeeAt:requestedAt,takerFeeSource:'exchange',
            ...(fees.makerFeeRate===undefined?{}:{makerFeeRate:fees.makerFeeRate,makerFeeAt:requestedAt,makerFeeSource:'exchange' as const})};succeeded=true;
          try{this.options.onObservation?.(task.symbol,{...task.entry.value});}catch{/* Reference persistence cannot fail the native read. */}
        }
      }).catch(()=>{/* Unknown fees are not a failed position read and private payloads never escape. */}).finally(()=>{
        task.entry.retryAt=succeeded?requestedAt+NATIVE_FEE_REFRESH_MS:this.now()+NATIVE_FEE_RETRY_MS;
        task.entry.pending=undefined;task.resolve(this.cached(task.symbol));this.running--;this.drain();
      });
    }
  }
  stop(){this.stopped=true;this.entries.clear();for(const task of this.queue)task.resolve(undefined);this.queue=[];}
}
