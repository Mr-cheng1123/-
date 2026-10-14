import type {AccountState,AppConfig,ExchangeId,LivePortfolio,LivePortfolioExchange} from '../shared/types.js';
import {inspectLiveEnvironment} from './live-readiness.js';
import {CcxtAdapter} from '../adapters/ccxt.js';
import {NATIVE_FEE_MAX_AGE_MS} from '../adapters/native-trading-fees.js';
import {gateReadError} from '../adapters/gate-private.js';
import {bitgetAccountReadError} from '../adapters/bitget-account.js';
import {bybitReadError} from '../adapters/bybit-private.js';
import {exchangeApiCode,ExchangeNetworkError} from '../adapters/network.js';
import {tradingError} from './trading-errors.js';

function readErrorMessage(exchange:ExchangeId,error:unknown):string {
  const known=gateReadError(error)??bitgetAccountReadError(error)??bybitReadError(error);
  if(known)return `${known}；后台会自动重试，当前数量和损益未知`;
  if(error instanceof ExchangeNetworkError||exchangeApiCode(exchange,error))return `${tradingError(exchange,'账户检查',error).message}；后台会自动重试`;
  return '持仓读取失败或超时，请检查网络、API 读取权限及账户模式；当前数量和损益未知';
}

type ReadClient={fetchAccount:()=>Promise<AccountState>;close:()=>Promise<void>};
interface Options {env?:Readonly<Record<string,string|undefined>>;pollIntervalMs?:number;timeoutMs?:number;maxAgeMs?:number;
  onObservation?:(portfolio:LivePortfolio)=>Promise<void>;
  createClient?:(exchange:ExchangeId,config:AppConfig)=>ReadClient;now?:()=>number}
interface Pending {client:ReadClient;token:object;response:Promise<void>}
const cashFlowStatuses=new Set(['loading','ready','incomplete','error','unavailable','stale']);
const cashFlowReasons=new Set(['正在读取当前持仓周期账单','账单已完整核对','账单无法完整归属当前持仓周期',
  '账单请求失败，后台会自动重试','交易所未返回当前持仓周期时间','账单证据已过期，等待重新读取']);

/** Separate clients and scheduler. This service exposes only account GETs and never touches execution state. */
export class LivePortfolioMonitor {
  private values=new Map<ExchangeId,LivePortfolioExchange>();
  private clients=new Map<ExchangeId,ReadClient>();
  private pending=new Map<ExchangeId,Pending>();
  private timer?:ReturnType<typeof setInterval>;private generation=0;private stopped=false;
  readonly pollIntervalMs:number;readonly maxAgeMs:number;private readonly timeoutMs:number;
  private now:()=>number;
  constructor(private config:()=>AppConfig,private options:Options={}){
    this.pollIntervalMs=options.pollIntervalMs??5000;this.maxAgeMs=options.maxAgeMs??15000;
    this.timeoutMs=options.timeoutMs??8000;this.now=options.now??Date.now;
  }
  start(){this.stopped=false;if(this.timer)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),this.pollIntervalMs);}
  state():LivePortfolio{
    const now=this.now(),enabled=new Set(this.config().exchanges);
    const exchanges=inspectLiveEnvironment(this.options.env??process.env).exchanges.filter(e=>enabled.has(e.exchange)).map(e=>{
      if(!e.credentialsConfigured)return {exchange:e.exchange,credentialsConfigured:false,status:'not_configured' as const,positions:[],message:'未配置账户，不能读取真实持仓'};
      const value=this.values.get(e.exchange)??{exchange:e.exchange,credentialsConfigured:true,status:'loading' as const,positions:[],message:'等待读取交易所持仓'};
      if(value.status==='ready'&&(!value.requestedAt||now-value.requestedAt>this.maxAgeMs||value.requestedAt>now))
        return {...value,status:'stale' as const,positions:[],freeUsd:undefined,equityUsd:undefined,message:'持仓快照已过期，等待重新读取'};
      return structuredClone(value);
    });
    return {timestamp:now,pollIntervalMs:this.pollIntervalMs,maxAgeMs:this.maxAgeMs,exchanges};
  }
  async refresh():Promise<LivePortfolio>{
    if(this.stopped||this.config().mode!=='live')return this.state();
    const enabled=new Set(this.config().exchanges),configured=inspectLiveEnvironment(this.options.env??process.env).exchanges.filter(e=>enabled.has(e.exchange)&&e.credentialsConfigured);
    await Promise.allSettled(configured.map(e=>this.read(e.exchange)));
    const observed=this.state();
    // Archiving is a separate read-only observation path; a failure must not erase a valid account snapshot.
    if(this.options.onObservation)await this.options.onObservation(observed).catch(()=>{});
    return observed;
  }
  private read(exchange:ExchangeId):Promise<void>{
    const existing=this.pending.get(exchange);if(existing)return existing.response;
    const token={},generation=this.generation,requestedAt=this.now();
    let client=this.clients.get(exchange);
    try{
      if(!client){
        client=(this.options.createClient??((id,config)=>{
          const adapter=new CcxtAdapter(id,config);return {fetchAccount:()=>adapter.fetchPortfolioAccount(),close:()=>adapter.close()};
        }))(exchange,{...this.config(),mode:'live',dataSource:'public',autoEnabled:false});
        this.clients.set(exchange,client);
      }
    }catch{this.values.set(exchange,{exchange,credentialsConfigured:true,status:'error',positions:[],requestedAt,message:'账户连接创建失败，请检查本机配置'});return Promise.resolve();}
    const reader=client,prior=this.values.get(exchange);
    // During a short refresh retain only the last successful, still-fresh snapshot.
    // Keep the last failure visible during retries instead of flashing back to indefinite loading.
    if(prior?.status!=='ready'&&prior?.status!=='error')this.values.set(exchange,{exchange,credentialsConfigured:true,status:'loading',positions:[],requestedAt,lastSuccessAt:prior?.lastSuccessAt,message:'正在读取交易所持仓'});
    const raw=Promise.resolve().then(()=>reader.fetchAccount());let timeout:ReturnType<typeof setTimeout>;
    const response=Promise.race([raw,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('PortfolioTimeout')),this.timeoutMs);})])
      .then(account=>{
        if(this.stopped||generation!==this.generation)return;
        if(!Number.isFinite(account.freeUsd)||!Number.isFinite(account.equityUsd)||!Array.isArray(account.positions)||account.positions.some(p=>
          !p||typeof p.base!=='string'||typeof p.symbol!=='string'||!['long','short'].includes(p.side)||!Number.isFinite(p.quantity)||p.quantity<0||!Number.isFinite(p.markPrice)||p.markPrice<=0))throw new Error('InvalidPortfolio');
        // Explicitly select normalized fields; raw private payloads and authentication never reach the API.
        const positions=account.positions.filter(p=>p.quantity>0).map(p=>({base:p.base,symbol:p.symbol,side:p.side,quantity:p.quantity,
          ...(Number.isInteger(p.splitPositionCount)&&p.splitPositionCount!>1?{splitPositionCount:p.splitPositionCount}:{}),
          ...(typeof p.positionMetricReason==='string'&&p.positionMetricReason.length<=160?{positionMetricReason:p.positionMetricReason}:{}),
          ...(typeof p.positionId==='string'&&/^[1-9]\d{0,63}$/.test(p.positionId)?{positionId:p.positionId}:{}),
          markPrice:p.markPrice,liquidationPrice:p.liquidationPrice,leverage:p.leverage,
          ...(['crossed','isolated'].includes(p.marginMode??'')?{marginMode:p.marginMode}:{}),
          ...(Number.isFinite(p.entryPrice)&&p.entryPrice!>0?{entryPrice:p.entryPrice}:{}),
          ...(Number.isFinite(p.unrealizedPnlUsd)?{unrealizedPnlUsd:p.unrealizedPnlUsd}:{}),
          ...(Number.isFinite(p.realizedPnlUsd)?{realizedPnlUsd:p.realizedPnlUsd}:{}),
          ...(Number.isFinite(p.fundingUsd)?{fundingUsd:p.fundingUsd}:{}),...(Number.isFinite(p.feesUsd)?{feesUsd:p.feesUsd}:{}),
          ...(Number.isFinite(p.cashFlowAt)?{cashFlowAt:p.cashFlowAt}:{}),
          ...(Number.isFinite(p.cashFlowSince)&&p.cashFlowSince!>0?{cashFlowSince:p.cashFlowSince}:{}),
          ...(cashFlowStatuses.has(p.cashFlowStatus??'')?{cashFlowStatus:p.cashFlowStatus,
            ...(cashFlowReasons.has(p.cashFlowReason??'')?{cashFlowReason:p.cashFlowReason}:{})}:{}),
          ...(p.takerFeeSource==='exchange'&&Number.isFinite(p.takerFeeRate)&&p.takerFeeRate!>=0&&p.takerFeeRate!<=.01&&
            Number.isFinite(p.takerFeeAt)&&p.takerFeeAt!>0&&p.takerFeeAt!<=this.now()&&this.now()-p.takerFeeAt!<=NATIVE_FEE_MAX_AGE_MS
              ?{takerFeeRate:p.takerFeeRate,takerFeeAt:p.takerFeeAt,takerFeeSource:'exchange' as const}:{}),
          ...(p.feeReference?.source==='account-reference'&&Number.isFinite(p.feeReference.takerRate)&&p.feeReference.takerRate>=0&&p.feeReference.takerRate<=.01&&
            Number.isFinite(p.feeReference.observedAt)&&p.feeReference.observedAt>0&&p.feeReference.observedAt<=this.now()
            ?{feeReference:{...p.feeReference}}:{}),
          ...(Number.isFinite(p.positionOpenedAt)&&p.positionOpenedAt!>0?{positionOpenedAt:p.positionOpenedAt}:{}),
          ...(Number.isFinite(p.positionUpdatedAt)&&p.positionUpdatedAt!>0?{positionUpdatedAt:p.positionUpdatedAt}:{}),
          ...(['price','not_liquidatable','unavailable'].includes(p.liquidationStatus??'')?{liquidationStatus:p.liquidationStatus}:{}),
          ...(typeof p.liquidationReason==='string'&&p.liquidationReason.length<=120?{liquidationReason:p.liquidationReason}:{})}));
        const receivedAt=this.now();this.values.set(exchange,{exchange,credentialsConfigured:true,status:'ready',requestedAt,receivedAt,lastSuccessAt:receivedAt,
          positions,freeUsd:account.freeUsd,equityUsd:account.equityUsd});
      }).catch(error=>{
        if(this.stopped||generation!==this.generation)return;
        this.values.set(exchange,{exchange,credentialsConfigured:true,status:'error',requestedAt,lastSuccessAt:prior?.lastSuccessAt,positions:[],
          message:readErrorMessage(exchange,error)});
        // Reuse initialized market metadata and connections. The pending raw read below
        // still prevents overlapping retries; reset/stop closes the client explicitly.
      }).finally(()=>clearTimeout(timeout));
    this.pending.set(exchange,{client:reader,token,response});
    // Keep the raw request registered after timeout; late completion must not be presented or overlap a retry.
    void raw.finally(()=>{if(this.pending.get(exchange)?.token===token)this.pending.delete(exchange);}).catch(()=>{});
    return response;
  }
  reset(){
    this.generation++;this.values.clear();const clients=[...this.clients.values()];this.clients.clear();
    this.pending.clear();for(const client of clients)void client.close().catch(()=>{});
  }
  async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.reset();}
}
