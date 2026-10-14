import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import type { ExchangeId } from '../shared/types.js';
import { FUNDING_RANGES, type FundingRange, type FundingStatsDataset, type FundingStatsRow } from '../shared/funding-statistics.js';

const API='https://open-api-v4.coinglass.com/api/futures/funding-rate/';
const SOURCE='https://www.coinglass.com/FundingRate';
type JsonResponse={status:number;json():Promise<unknown>};
type RequestOptions={headers:Record<string,string>;signal:AbortSignal};
export type CoinGlassRequest=(url:string,options:RequestOptions)=>Promise<JsonResponse>;
interface ClientOptions {
  /** Injectable boundaries for deterministic tests; production uses process.env. */
  env?:NodeJS.ProcessEnv;
  now?:()=>number;
  request?:CoinGlassRequest;
  timeoutMs?:number;
}
type FailureKind='authentication'|'permission'|'rate_limit'|'configuration'|'invalid_data'|'timeout'|'network'|'stopped';
class FundingDataError extends Error {constructor(readonly kind:FailureKind){super(kind);}}
const messageFor=(kind:FailureKind):string=>({
  authentication:'CoinGlass API Key 缺失或无效，请检查服务器环境变量 COINGLASS_API_KEY。',
  permission:'CoinGlass 拒绝访问，请检查 API 套餐权限或网络出口。',
  rate_limit:'CoinGlass 请求已限流，稍后自动重试。',
  configuration:'CoinGlass 代理配置无效；支持 HTTP/HTTPS 代理或 direct。',
  invalid_data:'CoinGlass 返回的数据格式异常，本次未更新缓存。',
  timeout:'CoinGlass 请求超时，稍后自动重试。',
  network:'CoinGlass 网络请求失败，稍后自动重试。',
  stopped:'CoinGlass 数据服务已停止。',
}[kind]);
const finite=(value:unknown):number|null=>{
  if(typeof value!=='number'&&typeof value!=='string')return null;
  if(typeof value==='string'&&!value.trim())return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const venues:Record<string,ExchangeId>={binance:'binance',bybit:'bybit',okx:'okx',gate:'gate',gateio:'gate',bitget:'bitget'};
const venue=(value:unknown):ExchangeId|undefined=>typeof value==='string'?venues[value.trim().toLowerCase().replace(/[\s._-]/g,'')]:undefined;
const ttl=(range:FundingRange)=>range==='current'?20_000:3_600_000;
const maxAge=(range:FundingRange)=>range==='current'?120_000:7_200_000;

/** CoinGlass rates are percentage points; the application uses decimal fractions. */
export function normalizeCoinGlassRows(data:unknown,range:FundingRange,receivedAt:number):FundingStatsRow[]{
  if(!Array.isArray(data))throw new FundingDataError('invalid_data');
  const rows=new Map<string,FundingStatsRow>();
  for(const entry of data){
    const raw=object(entry);
    if(!raw||typeof raw.symbol!=='string'||!Array.isArray(raw.stablecoin_margin_list))continue;
    const base=raw.symbol.toUpperCase();
    // Coin tickers may contain Unicode letters, including Chinese names.
    if(!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,39}$/u.test(base))continue;
    for(const candidate of raw.stablecoin_margin_list){
      const cell=object(candidate);if(!cell)continue;
      const exchange=venue(cell.exchange),percentage=finite(cell.funding_rate);
      if(!exchange||percentage===null)continue;
      let row=rows.get(base);if(!row){row={base,cells:{}};rows.set(base,row);}
      // Deterministic first valid record wins; a duplicate cannot silently replace its counterpart.
      if(row.cells[exchange])continue;
      const hours=finite(cell.funding_rate_interval),next=finite(cell.next_funding_time);
      row.cells[exchange]={exchange,rate:percentage/100,
        intervalHours:range==='current'&&hours!==null&&hours>0?hours:null,
        nextFundingTime:range==='current'&&next!==null&&next>0?next:null,
        updatedAt:receivedAt,timestampKind:'received',available:true};
    }
  }
  return [...rows.values()].sort((a,b)=>a.base.localeCompare(b.base));
}

function selectProxy(env:NodeJS.ProcessEnv):string|undefined{
  const value=env.COINGLASS_PROXY_URL??env.EXCHANGE_PROXY_URL??env.HTTPS_PROXY??env.https_proxy??env.HTTP_PROXY??env.http_proxy;
  if(!value||value.trim().toLowerCase()==='direct')return undefined;
  try{const url=new URL(value);if(url.protocol==='http:'||url.protocol==='https:')return url.href;}catch{/* Only a fixed safe message may leave this module. */}
  throw new FundingDataError('configuration');
}
function withAbort<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return Promise.reject(new FundingDataError('timeout'));
  return new Promise((resolve,reject)=>{
    const cancel=()=>reject(new FundingDataError('timeout'));
    signal.addEventListener('abort',cancel,{once:true});
    pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));
  });
}

/** Server-only official API cache. Reading a dataset never blocks on the network. */
export class CoinGlassFundingStatistics {
  readonly configured:boolean;
  private readonly apiKey:string;
  private readonly now:()=>number;
  private readonly request:CoinGlassRequest;
  private readonly timeoutMs:number;
  private readonly cache=new Map<FundingRange,FundingStatsDataset>();
  private readonly pending=new Map<FundingRange,Promise<void>>();
  private readonly controllers=new Set<AbortController>();
  private readonly queue:Array<()=>void>=[];
  private active=0;
  private stopped=false;
  private dispatcher?:Dispatcher;
  private configurationError=false;

  constructor(options:ClientOptions={}){
    const env=options.env??process.env;
    this.apiKey=env.COINGLASS_API_KEY?.trim()??'';
    this.configured=Boolean(this.apiKey);
    this.now=options.now??Date.now;
    this.timeoutMs=Math.max(1,Math.min(8000,options.timeoutMs??8000));
    if(!options.request&&this.configured){
      try{const proxy=selectProxy(env);if(proxy)this.dispatcher=new ProxyAgent(proxy);}
      catch{this.configurationError=true;}
    }
    this.request=options.request??((url,init)=>fetch(url,{...init,dispatcher:this.dispatcher,redirect:'error'}));
  }

  private initial(range:FundingRange):FundingStatsDataset{
    return {source:'coinglass',range,status:this.configured?'loading':'not_configured',rows:[],receivedAt:0,lastAttemptAt:0,nextRefreshAt:0,
      maxAgeMs:maxAge(range),sourceUrl:SOURCE,marginScope:'USDT/USD 保证金（CoinGlass stablecoin_margin_list）',
      message:this.configured?undefined:'尚未配置 CoinGlass API Key；请在服务器 .env 中设置 COINGLASS_API_KEY。'};
  }

  get(range:FundingRange):FundingStatsDataset{
    if(!FUNDING_RANGES.includes(range))throw new Error('不支持的资金费率统计周期');
    if(!this.cache.has(range))this.cache.set(range,this.initial(range));
    const cached=this.cache.get(range)!;
    if(this.configured&&!this.stopped&&this.now()>=cached.nextRefreshAt&&!this.pending.has(range))void this.refresh(range);
    const result=this.cache.get(range)!;
    if(result.receivedAt>0&&this.now()-result.receivedAt>result.maxAgeMs)return {...result,status:'stale',message:result.message??'CoinGlass 数据已过期，等待重新同步。'};
    return {...result};
  }

  refresh(range:FundingRange):Promise<void>{
    if(!FUNDING_RANGES.includes(range))return Promise.reject(new Error('不支持的资金费率统计周期'));
    const running=this.pending.get(range);if(running)return running;
    const cached=this.cache.get(range)??this.initial(range);
    this.cache.set(range,cached);
    if(!this.configured||this.stopped||this.now()<cached.nextRefreshAt)return Promise.resolve();
    const promise=this.update(range).finally(()=>this.pending.delete(range));
    this.pending.set(range,promise);return promise;
  }

  private async acquire(signal:AbortSignal):Promise<void>{
    if(signal.aborted)throw new FundingDataError('timeout');
    if(this.active<2){this.active++;return;}
    await new Promise<void>((resolve,reject)=>{
      const take=()=>{signal.removeEventListener('abort',cancel);this.active++;resolve();};
      const cancel=()=>{const index=this.queue.indexOf(take);if(index>=0)this.queue.splice(index,1);reject(new FundingDataError('timeout'));};
      signal.addEventListener('abort',cancel,{once:true});this.queue.push(take);
    });
  }
  private release(){this.active--;this.queue.shift()?.();}

  private async update(range:FundingRange):Promise<void>{
    const previous=this.cache.get(range)!;
    this.cache.set(range,{...previous,lastAttemptAt:this.now(),status:previous.receivedAt?'ready':'loading',message:undefined});
    const controller=new AbortController();this.controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    let acquired=false;
    try{
      if(this.configurationError)throw new FundingDataError('configuration');
      await this.acquire(controller.signal);acquired=true;
      const url=API+(range==='current'?'exchange-list':`accumulated-exchange-list?range=${range}`);
      const response=await withAbort(this.request(url,{headers:{accept:'application/json','CG-API-KEY':this.apiKey},signal:controller.signal}),controller.signal);
      if(response.status===401)throw new FundingDataError('authentication');
      if(response.status===403)throw new FundingDataError('permission');
      if(response.status===429)throw new FundingDataError('rate_limit');
      if(response.status<200||response.status>=300)throw new FundingDataError('network');
      const payload=object(await withAbort(response.json(),controller.signal));
      if(!payload)throw new FundingDataError('invalid_data');
      // CoinGlass also returns HTTP 200 with { code: '401' } for a missing API key.
      const code=String(payload.code??'');
      if(code==='401')throw new FundingDataError('authentication');
      if(code==='403')throw new FundingDataError('permission');
      if(code==='429')throw new FundingDataError('rate_limit');
      if(code!=='0')throw new FundingDataError('invalid_data');
      const receivedAt=this.now(),rows=normalizeCoinGlassRows(payload.data,range,receivedAt);
      if(this.stopped)return;
      this.cache.set(range,{...this.cache.get(range)!,status:'ready',rows,receivedAt,nextRefreshAt:receivedAt+ttl(range),message:undefined});
    }catch(error){
      const kind:FailureKind=this.stopped?'stopped':controller.signal.aborted?'timeout':error instanceof FundingDataError?error.kind:'network';
      const retryDelay=kind==='authentication'||kind==='permission'||kind==='configuration'?60_000:30_000;
      const rows=previous.rows.map(row=>({...row,cells:Object.fromEntries(Object.entries(row.cells).map(([id,cell])=>[id,{...cell,available:false}]))}));
      this.cache.set(range,{...this.cache.get(range)!,rows,status:previous.receivedAt&&this.now()-previous.receivedAt>maxAge(range)?'stale':'error',nextRefreshAt:this.now()+retryDelay,message:messageFor(kind)});
    }finally{clearTimeout(timer);this.controllers.delete(controller);if(acquired)this.release();}
  }

  async stop():Promise<void>{
    this.stopped=true;
    for(const controller of this.controllers)controller.abort();
    await Promise.allSettled([...this.pending.values()]);
    await this.dispatcher?.destroy();
  }
}
