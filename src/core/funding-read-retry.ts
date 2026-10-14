import type {ExchangeId} from '../shared/types.js';
import {classifyNetworkError,exchangeApiCode,type NetworkCode} from '../adapters/network.js';

export const FUNDING_READ_RETRY_MIN_MS=15_000;
export const FUNDING_READ_RETRY_MAX_MS=120_000;
export const FUNDING_READ_LOG_INTERVAL_MS=60_000;

export interface FundingReadClock {key:string;nextFundingTime?:number}
export type FundingReadPhase='read'|'attribute'|'save';
interface RetryState {
  failures:number;nextAttemptAt:number;lastFailureLogAt?:number;lastFailureSignature?:string;
  /** Only clocks actually observed in the future can trigger one boundary retry. */
  clocks:Map<string,number>;probedClocks:Map<string,number>;
}
export interface FundingReadFailure {reason:string;signature:string;apiCode?:string;code:NetworkCode|'LOCAL_ATTRIBUTION_ERROR'|'LOCAL_SAVE_ERROR'}

/** Output only application text and validated venue-scoped identifiers, never error bodies or credentials. */
export function fundingReadFailure(exchange:ExchangeId,error:unknown,phase:FundingReadPhase='read'):FundingReadFailure {
  if(phase!=='read'){
    const code=phase==='save'?'LOCAL_SAVE_ERROR':'LOCAL_ATTRIBUTION_ERROR';
    return {code,reason:phase==='save'?'资金费账单本地保存失败':'资金费账单本地归属核对失败',signature:`${code}:`};
  }
  let code:NetworkCode='API_ERROR';
  try{
    const ownMessage=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'message')?.value:undefined;
    code=typeof ownMessage==='string'&&ownMessage.startsWith('交易所只读请求超时')?'TIMEOUT':classifyNetworkError(error);
  }catch{/* An accessor or malformed exception cannot turn safe diagnostics into a new read failure. */}
  const apiCode=exchangeApiCode(exchange,error);
  // The generic transport category is useful even when an adapter exposes only a numeric API refusal.
  const reasons:Record<NetworkCode,string>={REGION_BLOCKED:'账单接口拒绝当前网络地区',ACCESS_DENIED:'账单接口拒绝访问或权限不足',
    PROXY_UNAVAILABLE:'账单读取代理不可用',RATE_LIMITED:'账单接口限流',TIMEOUT:'账单只读请求超时',
    DNS_ERROR:'账单接口域名解析失败',TLS_ERROR:'账单读取安全连接失败',NETWORK_ERROR:'账单网络连接中断',API_ERROR:'账单接口响应异常'};
  let reason=reasons[code];
  if(exchange==='bybit'&&apiCode){
    const known:Record<string,string>={'10001':'账单接口参数被拒绝','10002':'账单请求时间窗口不匹配',
      '10003':'账单接口密钥或环境不匹配','10004':'账单请求签名校验失败','10005':'账单接口读取权限不足',
      '10006':'账单接口限流','10000':'账单接口响应超时','10016':'账单接口暂时服务异常'};
    reason=known[apiCode]??reason;
  }
  return {code,apiCode,reason:reason+(apiCode?`（官方代码 ${apiCode}）`:''),signature:`${code}:${apiCode??''}`};
}

/** Funding-specific retry pacing. Adapter identity prevents a replaced credential/client inheriting old failures. */
export class FundingReadRetry {
  private states=new WeakMap<object,RetryState>();
  private state(adapter:object):RetryState {
    let state=this.states.get(adapter);
    if(!state){state={failures:0,nextAttemptAt:0,clocks:new Map(),probedClocks:new Map()};this.states.set(adapter,state);}
    return state;
  }
  clear():void {this.states=new WeakMap();}
  forget(adapter:object):void {this.states.delete(adapter);}

  /** Pending raw requests always win over a clock or expired backoff; no second HTTP request is started. */
  ready(adapter:object,now:number,clocks:readonly FundingReadClock[],pending=false):boolean {
    const state=this.state(adapter),keys=new Set(clocks.map(clock=>clock.key));
    for(const key of state.clocks.keys())if(!keys.has(key)){state.clocks.delete(key);state.probedClocks.delete(key);}
    const due=[...state.clocks].filter(([key,at])=>at<=now&&state.probedClocks.get(key)!==at);
    for(const clock of clocks)if(Number.isFinite(clock.nextFundingTime)&&clock.nextFundingTime!>now)
      state.clocks.set(clock.key,clock.nextFundingTime!);
    if(pending||!Number.isFinite(now)||now<0)return false;
    if(now<state.nextAttemptAt&&!due.length)return false;
    for(const [key,at] of due)state.probedClocks.set(key,at);
    return true;
  }

  failed(adapter:object,error:unknown,exchange:ExchangeId,now:number,phase:FundingReadPhase='read'):FundingReadFailure&{delayMs:number;log:boolean} {
    const state=this.state(adapter),failure=fundingReadFailure(exchange,error,phase);
    state.failures=Math.min(state.failures+1,16);
    const delayMs=Math.min(FUNDING_READ_RETRY_MAX_MS,FUNDING_READ_RETRY_MIN_MS*2**(state.failures-1));
    state.nextAttemptAt=now+delayMs;
    const log=state.lastFailureSignature!==failure.signature||state.lastFailureLogAt===undefined||now-state.lastFailureLogAt>=FUNDING_READ_LOG_INTERVAL_MS;
    if(log){state.lastFailureLogAt=now;state.lastFailureSignature=failure.signature;}
    return {...failure,delayMs,log};
  }

  /** Only a complete accepted read can clear a failure. Late/raw promise completion never calls this. */
  succeeded(adapter:object):boolean {
    const state=this.state(adapter),recovered=state.failures>0;
    state.failures=0;state.nextAttemptAt=0;state.lastFailureLogAt=undefined;state.lastFailureSignature=undefined;
    return recovered;
  }
}
