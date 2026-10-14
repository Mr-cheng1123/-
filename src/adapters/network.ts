import { AsyncLocalStorage } from 'node:async_hooks';
import { pipeline } from 'node:stream/promises';
import ccxt from 'ccxt';
import type { ExchangeId } from '../shared/types.js';
import {exchangeClientId} from './normalization.js';
import {safeExchangeApiMessage,sanitizeApiMessage} from '../shared/exchange-api-diagnostic.js';
import {configureCcxtReadThrottle} from './ccxt-read-throttle.js';
import {installProxyConnectCancellation} from './proxy-connect-cancellation.js';

export type NetworkCode='REGION_BLOCKED'|'ACCESS_DENIED'|'PROXY_UNAVAILABLE'|'RATE_LIMITED'|'TIMEOUT'|'DNS_ERROR'|'TLS_ERROR'|'NETWORK_ERROR'|'API_ERROR';
export interface NetworkStatus { route:'proxy'|'direct';endpoint?:string;errorCode?:NetworkCode;retryAt?:number }
export interface ExchangeRequestContext { signal?:AbortSignal;deadlineAt?:number }
const requestContexts=new WeakMap<object,AsyncLocalStorage<ExchangeRequestContext>>();
const bybitNoSendProofs=new WeakMap<object,{client:object;method:'POST';endpoint:'/v5/order/create';nativeClientId:string}>();
const admittedBybitCreates=new WeakMap<object,Set<string>>();
const gateMakerCreateRejections=new WeakMap<object,{client:object;nativeClientId:string}>();
/** The installed Gate handler maps this exact business label to OrderImmediatelyFillable. */
function gatePostOnlyCreateRejected(error:unknown):boolean {
  try{
    if(!(error instanceof ccxt.ExchangeError)||error instanceof ccxt.NetworkError||
      !(error instanceof ccxt.OrderImmediatelyFillable)||classifyNetworkError(error)!=='API_ERROR')return false;
    const message=own(error,'message');
    if(typeof message!=='string'||message.length>65536||!message.startsWith('gate '))return false;
    const body=message.slice(5).trim(),payload=JSON.parse(body);
    if(!payload||Array.isArray(payload)||typeof payload!=='object'||payload.label!=='ORDER_POC_IMMEDIATE')return false;
    // Accept only the documented string fields, and reject repeated keys before JSON.parse could hide them.
    const strings=body.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g);
    const shape=body.replace(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g,'"string"');
    if(!strings||!/^\{\s*"string"\s*:\s*"string"(?:\s*,\s*"string"\s*:\s*"string")*\s*\}$/.test(shape))return false;
    const keys=new Set<string>();
    for(let index=0;index<strings.length;index+=2){
      const key=JSON.parse(strings[index]);if(!['label','message','detail'].includes(key)||keys.has(key))return false;keys.add(key);
    }
    return keys.has('label');
  }catch{return false;}
}
function gateMakerCreateIdentity(id:ExchangeId,url:string,method:string,body:unknown):string|undefined {
  if(id!=='gate'||method.toUpperCase()!=='POST'||typeof body!=='string'||body.length>65536)return;
  try{
    const endpoint=new URL(url);
    if(endpoint.protocol!=='https:'||endpoint.pathname!=='/api/v4/futures/usdt/orders')return;
    const payload=JSON.parse(body),nativeClientId=own(payload,'text');
    if(own(payload,'tif')==='poc'&&own(payload,'reduce_only')===true&&typeof nativeClientId==='string'&&
      /^t-[0-9A-Za-z_.-]{1,28}$/.test(nativeClientId))return nativeClientId;
  }catch{/* An unrelated or malformed request cannot establish a native create rejection. */}
}
/** Exact original-create evidence only; no response body or private diagnostics survive transport wrapping. */
export function consumeGateMakerCreateRejection(error:unknown,client:object,clientOrderId:string):boolean {
  if(!error||typeof error!=='object'||typeof clientOrderId!=='string')return false;
  const proof=gateMakerCreateRejections.get(error);
  if(proof){
    if(proof.client!==client||proof.nativeClientId!==exchangeClientId('gate',clientOrderId))return false;
    gateMakerCreateRejections.delete(error);return true;
  }
  // Bare native helpers do not install transport wrapping; their catch still owns this original POST.
  return gatePostOnlyCreateRejected(error);
}
/** Only the signed native creation payload identifies this request; no raw body is retained. */
function bybitCreateIdentity(id:ExchangeId,url:string,method:string,body:unknown):string|undefined {
  if(id!=='bybit'||method.toUpperCase()!=='POST'||typeof body!=='string'||body.length>65536)return;
  try{
    const endpoint=new URL(url);if(endpoint.protocol!=='https:'||endpoint.pathname!=='/v5/order/create')return;
    const payload=JSON.parse(body),nativeId=own(payload,'orderLinkId');
    if(own(payload,'category')==='linear'&&typeof nativeId==='string'&&/^fa[0-9a-f]{26}$/.test(nativeId))return nativeId;
  }catch{/* A malformed or unrelated request cannot establish no-send evidence. */}
}
/** Read/consume internal transport evidence, bound to this client and original deterministic request ID. */
export function consumeBybitCreateNotSent(error:unknown,client:object,clientOrderId:string):boolean {
  if(!error||typeof error!=='object'||typeof clientOrderId!=='string')return false;
  const proof=bybitNoSendProofs.get(error);
  if(!proof||proof.client!==client||proof.method!=='POST'||proof.endpoint!=='/v5/order/create'||
    proof.nativeClientId!==exchangeClientId('bybit',clientOrderId)||
    admittedBybitCreates.get(client)?.has(proof.nativeClientId))return false;
  bybitNoSendProofs.delete(error);return true;
}
function requestStorage(client:object):AsyncLocalStorage<ExchangeRequestContext>{
  let storage=requestContexts.get(client);
  if(!storage){storage=new AsyncLocalStorage<ExchangeRequestContext>();requestContexts.set(client,storage);}
  return storage;
}
/** Scope a logical read to one deadline, including pagination, response bodies and queued retries. */
export function withExchangeRequestContext<T>(client:object,context:ExchangeRequestContext,operation:()=>Promise<T>):Promise<T>{
  const storage=requestStorage(client),parent=storage.getStore();
  const deadlines=[parent?.deadlineAt,context.deadlineAt].filter((value):value is number=>Number.isFinite(value));
  const signals=[parent?.signal,context.signal].filter((value):value is AbortSignal=>value!==undefined);
  return storage.run({deadlineAt:deadlines.length?Math.min(...deadlines):undefined,
    signal:signals.length>1?AbortSignal.any(signals):signals[0]},operation);
}
/** Long-lived background callbacks use their own normal HTTP budgets, never a caller's batch deadline. */
export function withoutExchangeRequestContext<T>(client:object,operation:()=>T):T {
  return requestStorage(client).exit(operation);
}
// Gate API v4 documented label list: https://www.gate.com/docs/developers/apiv4/en/#label-list
// Retain only these identifiers, never the response message, URL, headers or body.
export const GATE_API_LABELS=Object.freeze([
  'NO_CHANGE','READ_ONLY','FORBIDDEN','IP_FORBIDDEN','INVALID_CREDENTIALS','INVALID_KEY','INVALID_SIGNATURE',
  'REQUEST_EXPIRED','ACCOUNT_LOCKED','LEVERAGE_TOO_LOW','LEVERAGE_TOO_HIGH','POSITION_EMPTY',
  'INVALID_PARAM_VALUE','INVALID_REQUEST_BODY','INVALID_ARGUMENT','MISSING_REQUIRED_PARAM',
  'CONTRACT_NOT_FOUND','USER_NOT_FOUND','INSUFFICIENT_AVAILABLE','POSITION_CROSS_MARGIN',
  'POSITION_DUAL_MODE','ORDER_PENDING','POSITION_HOLDING','POSITION_NOT_FOUND',
] as const);
export type GateApiLabel=typeof GATE_API_LABELS[number];
const gateApiLabels=new Set<string>(GATE_API_LABELS);
function validApiCode(exchange:ExchangeId|undefined,value:unknown):string|undefined{
  if(typeof value==='number'&&Number.isSafeInteger(value))value=String(value);
  if(typeof value!=='string')return undefined;
  if(exchange==='binance'&&/^-[1-9]\d{3,5}$/.test(value))return value;
  if(exchange==='bybit'&&/^(?:429|[1-9]\d{3,7})$/.test(value))return value;
  if(exchange==='okx'&&(/^[12]$/.test(value)||/^\d{5}$/.test(value)&&value!=='00000'))return value;
  if((exchange==='bitget'||exchange===undefined)&&/^\d{5}$/.test(value)&&value!=='00000')return value;
  if((exchange==='gate'||exchange===undefined)&&gateApiLabels.has(value))return value;
  return undefined;
}
export class ExchangeNetworkError extends Error {
  readonly apiCode?:string;
  readonly apiMessage?:string;
  constructor(readonly code:NetworkCode,readonly retryAt=0,apiCode?:string,readonly exchange?:ExchangeId,apiMessage?:string){
    super(networkMessage(code));this.name='ExchangeNetworkError';this.apiCode=validApiCode(exchange,apiCode);
    if(exchange==='bybit'&&code==='API_ERROR')this.apiMessage=sanitizeApiMessage(apiMessage);
  }
}
function own(value:unknown,key:string):unknown{
  return value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
}
function okxSubCode(payload:unknown):string|undefined{
  const subCode=(value:unknown)=>{
    const valid=validApiCode('okx',value);return valid?.length===5?valid:undefined;
  };
  const direct=subCode(own(payload,'sCode'));if(direct)return direct;
  const data=own(payload,'data'),length=own(data,'length');
  if(Array.isArray(data)&&typeof length==='number')for(let i=0;i<Math.min(length,100);i++){
    const value=subCode(own(own(data,String(i)),'sCode'));if(value)return value;
  }
  return undefined;
}
function payloadCode(exchange:ExchangeId,payload:unknown):string|undefined{
  return validApiCode(exchange,own(payload,exchange==='gate'?'label':exchange==='bybit'?'retCode':'code'));
}
/** Extract venue-scoped primitive identifiers; never retain response text or invoke getters. */
export function exchangeApiCode(exchange:ExchangeId,error:unknown):string|undefined{
  try{
    const markedExchange=own(error,'exchange');if(typeof markedExchange==='string'&&markedExchange!==exchange)return undefined;
    const direct=validApiCode(exchange,own(error,'apiCode'));if(direct)return direct;
    const structuredSub=exchange==='okx'?okxSubCode(error):undefined;if(structuredSub)return structuredSub;
    const structured=payloadCode(exchange,error);
    if(!(error instanceof Error))return structured;
    const message=own(error,'message');if(typeof message!=='string'||message.length>65536)return structured;
    const start=message.indexOf('{');if(start<0)return structured;
    const prefix=message.slice(0,start).trim(),venuePrefix=prefix.match(/^(binance(?:usdm|coinm)?|bybit|okx|gate(?:io)?|bitget)(?:\s|$)/)?.[1];
    const messageExchange=venuePrefix?.startsWith('binance')?'binance':venuePrefix==='gateio'?'gate':venuePrefix;
    if(messageExchange&&messageExchange!==exchange)return undefined;
    // CCXT carries the official JSON after the venue name. Parse it as data so strings
    // inside a private message cannot masquerade as code/retCode/sCode fields.
    let payload:unknown;try{payload=JSON.parse(message.slice(start));}catch{return structured;}
    return (exchange==='okx'?okxSubCode(payload):undefined)??structured??payloadCode(exchange,payload);
  }catch{return undefined;}
}
export function networkMessage(code:NetworkCode):string{
  return {REGION_BLOCKED:'交易所拒绝当前网络出口所在地区；需要可访问该交易所的代理线路',ACCESS_DENIED:'交易所拒绝访问，请检查网络出口或接口权限',PROXY_UNAVAILABLE:'本机代理不可用，请检查代理程序或端口',RATE_LIMITED:'交易所限流，已退避并自动恢复',TIMEOUT:'网络请求超时，正在自动重连；过期数据不会用于开仓',DNS_ERROR:'交易所域名解析失败，请检查网络或代理',TLS_ERROR:'安全连接失败，请检查网络线路',NETWORK_ERROR:'网络连接中断，正在自动重连',API_ERROR:'交易所接口响应异常'}[code];
}
export function classifyNetworkError(error:unknown,usingProxy=false):NetworkCode{
  if(error instanceof ExchangeNetworkError)return error.code;
  const text=(error instanceof Error?`${error.name} ${error.message}`:String(error)).replace(/\s+/g,' ');
  // CCXT can label a country-blocked 403 as RateLimitExceeded. Inspect the real response first.
  if(/restricted location|block.{0,180}(?:country|region)|(?:country|region).{0,180}block|unavailable.*(?:country|region)|\b451\b/i.test(text))return 'REGION_BLOCKED';
  if(/\b403\b|forbidden|access denied/i.test(text))return 'ACCESS_DENIED';
  if(/429|too many requests|RateLimitExceeded|DDoSProtection/i.test(text))return 'RATE_LIMITED';
  if(usingProxy&&/ECONNREFUSED|proxy.*(?:failed|refused|error)/i.test(text))return 'PROXY_UNAVAILABLE';
  if(/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text))return 'DNS_ERROR';
  if(/certificate|ERR_TLS|SSL_|TLS.*failed/i.test(text))return 'TLS_ERROR';
  if(/timeout|timed out|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|AbortError/i.test(text))return 'TIMEOUT';
  if(own(error,'code')==='ERR_STREAM_PREMATURE_CLOSE'||/NetworkError|ExchangeNotAvailable|ECONNRESET|EHOSTUNREACH|fetch failed|socket|ECONNREFUSED/i.test(text))return 'NETWORK_ERROR';
  return 'API_ERROR';
}
export function proxyFor(exchange:ExchangeId,env:NodeJS.ProcessEnv=process.env):string|undefined{
  const value=env[`${exchange.toUpperCase()}_PROXY_URL`]??env.EXCHANGE_PROXY_URL??env.HTTPS_PROXY??env.https_proxy??env.HTTP_PROXY??env.http_proxy;
  return validatedProxy(value);
}
function validatedProxy(value:string|undefined):string|undefined{
  if(!value||value.toLowerCase()==='direct')return undefined;
  let url:URL;try{url=new URL(value);}catch{throw new Error('代理地址格式无效，应为 http://主机:端口');}
  if(!['http:','https:','socks5:','socks5h:'].includes(url.protocol))throw new Error('代理协议仅支持 HTTP、HTTPS 或 SOCKS5');
  return value;
}
const statuses=new WeakMap<object,NetworkStatus>();
export function getExchangeNetworkStatus(client:object):NetworkStatus|undefined{return statuses.get(client);}
const bounded=(value:string|undefined,defaultValue:number,min:number,max:number)=>{const n=Number(value);return value&&Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):defaultValue;};
function assertRequestActive(context:ExchangeRequestContext|undefined,id:ExchangeId):void{
  if(context?.signal?.aborted||context?.deadlineAt!==undefined&&Date.now()>=context.deadlineAt)
    throw new ExchangeNetworkError('TIMEOUT',0,undefined,id);
}
/** Check a logical read's inherited budget before starting another native call. */
export function assertExchangeRequestActive(client:object,id:ExchangeId):void {
  assertRequestActive(requestStorage(client).getStore(),id);
}
function sleep(ms:number,context:ExchangeRequestContext|undefined,id:ExchangeId):Promise<void>{
  assertRequestActive(context,id);
  return new Promise((resolve,reject)=>{
    const finish=()=>{context?.signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(finish,ms);
    const abort=()=>{clearTimeout(timer);context?.signal?.removeEventListener('abort',abort);reject(new ExchangeNetworkError('TIMEOUT',0,undefined,id));};
    context?.signal?.addEventListener('abort',abort,{once:true});
    if(context?.signal?.aborted)abort();
  });
}
const retryable=new Set<NetworkCode>(['TIMEOUT','NETWORK_ERROR','DNS_ERROR','PROXY_UNAVAILABLE','TLS_ERROR']);
const cooldown=(code:NetworkCode)=>code==='REGION_BLOCKED'||code==='ACCESS_DENIED'?60000:code==='RATE_LIMITED'?10000:3000;
function isPublicMarketRequest(url:string,id:ExchangeId):boolean{
  let pathname:string;try{pathname=new URL(url).pathname;}catch{return false;}
  if(id==='bybit')return pathname.startsWith('/v5/market/');
  if(id==='okx')return /^\/api\/v5\/(public|market)\//.test(pathname);
  if(id==='bitget')return /^\/api\/v[23]\/mix\/market\//.test(pathname);
  if(id==='gate')return /^\/api\/v4\/futures\/(usdt|btc)\/(contracts|tickers|order_book|funding_rate|candlesticks|contract_stats)(\/|$)/.test(pathname);
  return /^\/fapi\/v\d+\/(premiumIndex|fundingRate|fundingInfo|exchangeInfo|ticker|depth|openInterest|time|klines|continuousKlines|indexPriceKlines|markPriceKlines|ping)(\/|$)/.test(pathname);
}

/** Apply only to the app's own client; never change Windows or other applications' proxy settings. */
export function configureExchangeTransport(client:any,id:ExchangeId,options?:{proxyUrl?:string}):void{
  const proxy=options?validatedProxy(options.proxyUrl):proxyFor(id),state:NetworkStatus={route:proxy?'proxy':'direct'};
  const storage=requestStorage(client);
  statuses.set(client,state);
  configureCcxtReadThrottle(client,{getContext:()=>storage.getStore(),
    timeoutError:()=>new ExchangeNetworkError('TIMEOUT',0,undefined,id)});
  installProxyConnectCancellation(client,()=>storage.getStore());
  let timeoutMs=bounded(process.env.EXCHANGE_HTTP_TIMEOUT_MS,8000,1000,30000);
  // Request-local budgets avoid mutating a shared client's timeout while another leg is trading.
  Object.defineProperty(client,'timeout',{configurable:true,enumerable:true,
    get(){const deadline=storage.getStore()?.deadlineAt;return deadline===undefined?timeoutMs:Math.max(1,Math.min(timeoutMs,Math.ceil(deadline-Date.now())));},
    set(value:unknown){if(typeof value==='number'&&Number.isFinite(value)&&value>0)timeoutMs=value;}});
  client.maxRetriesOnFailure=0;
  client.options={...client.options,maxRetriesOnFailure:0};
  if(proxy){if(proxy.startsWith('socks'))client.socksProxy=proxy;else client.httpsProxy=proxy;}
  // OKX's official May 2026 API-domain migration, including public market data.
  if(id==='okx'&&client.urls?.api){
    client.hostname='openapi.okx.com';
    const replace=(v:any):any=>typeof v==='string'?v.replace('https://www.okx.com','https://openapi.okx.com'):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
    client.urls.api=replace(client.urls.api);
  }
  const original=client.fetch.bind(client);
  // The installed native helper pipes compressed bodies without forwarding source
  // failures. Keep its decoding and Buffer semantics, but finish every body on
  // upstream errors or the same request's cancellation instead of hanging forever.
  if(typeof client.undiciBody==='function'){
    const originalBody=client.undiciBody.bind(client);
    client.undiciBody=async(response:any,binary=false)=>{
      const encoding=response.statusCode===204||response.statusCode===304?undefined:response.headers['content-encoding'];
      let decompressor:any;
      if(encoding==='gzip'||encoding==='x-gzip')decompressor=client.zlibModule.createGunzip();
      else if(encoding==='br')decompressor=client.zlibModule.createBrotliDecompress();
      else if(encoding==='deflate')decompressor=client.zlibModule.createInflate();
      if(decompressor===undefined)return originalBody(response,binary);
      const chunks:Uint8Array[]=[];
      await pipeline(response.body,decompressor,async(source)=>{
        for await(const chunk of source)chunks.push(chunk as Uint8Array);
      },{signal:storage.getStore()?.signal});
      const buffer=Buffer.concat(chunks);
      return binary?buffer:buffer.toString('utf8');
    };
  }
  // CCXT owns pooled keep-alive dispatchers. Keep those pools and add cancellation at its
  // native request boundary; unlike its header-only timer, this also aborts a stalled body.
  if(typeof client.undiciRequest==='function'){
    const originalRequest=client.undiciRequest.bind(client);
    client.undiciRequest=(url:string,params:any)=>{
      const context=storage.getStore();assertRequestActive(context,id);
      const signal=context?.signal;
      return originalRequest(url,signal?{...params,signal:params.signal?AbortSignal.any([params.signal,signal]):signal}:params);
    };
  }
  const retries=bounded(process.env.EXCHANGE_HTTP_RETRIES,1,0,2);
  let failureGeneration=0;
  client.fetch=async(url:string,method='GET',headers?:unknown,body?:unknown)=>{
    const nativeClientId=bybitCreateIdentity(id,url,method,body);
    const checkBeforeTransport=(context:ExchangeRequestContext|undefined)=>{
      try{assertRequestActive(context,id);}
      catch(error){
        // The original fetch has not been entered. Never downgrade a later retry
        // if an earlier attempt with this client/native ID already entered it.
        if(nativeClientId&&error&&typeof error==='object'&&!admittedBybitCreates.get(client)?.has(nativeClientId))
          bybitNoSendProofs.set(error,{client,method:'POST',endpoint:'/v5/order/create',nativeClientId});
        throw error;
      }
    };
    const parent=storage.getStore();checkBeforeTransport(parent);
    const deadlineAt=Math.min(Date.now()+timeoutMs,parent?.deadlineAt??Infinity);
    const budgetSignal=AbortSignal.timeout(Math.max(1,Math.ceil(deadlineAt-Date.now())));
    const context:ExchangeRequestContext={deadlineAt,signal:parent?.signal?AbortSignal.any([parent.signal,budgetSignal]):budgetSignal};
    const publicRequest=method.toUpperCase()==='GET'&&isPublicMarketRequest(url,id);
    // Market-data outages must not prevent cancellation, reducing exposure or querying an uncertain order.
    if(publicRequest&&state.retryAt&&Date.now()<state.retryAt)throw new ExchangeNetworkError(state.errorCode??'NETWORK_ERROR',state.retryAt,undefined,id);
    const startedGeneration=failureGeneration;
    try{state.endpoint=new URL(url).hostname;}catch{/* do not expose malformed URLs */}
    const attempts=method.toUpperCase()==='GET'?retries+1:1;
    for(let attempt=0;attempt<attempts;attempt++){
      checkBeforeTransport(context);
      // Another concurrent public request may have established a rate limit while this
      // request was sleeping. It must not resume sending through the new cooldown.
      if(publicRequest&&attempt>0&&state.retryAt&&Date.now()<state.retryAt)
        throw new ExchangeNetworkError(state.errorCode??'NETWORK_ERROR',state.retryAt,undefined,id);
      try{
        if(nativeClientId){let admitted=admittedBybitCreates.get(client);if(!admitted){admitted=new Set();admittedBybitCreates.set(client,admitted);}admitted.add(nativeClientId);}
        const result=await storage.run(context,()=>original(url,method,headers,body));
        assertRequestActive(context,id);
        if(publicRequest&&startedGeneration===failureGeneration){state.errorCode=undefined;state.retryAt=undefined;}
        return result;
      }
      catch(error){
        const code=context.signal?.aborted||Date.now()>=deadlineAt?'TIMEOUT':classifyNetworkError(error,Boolean(proxy));
        const delay=250*(attempt+1);
        if(attempt+1<attempts&&retryable.has(code)&&Date.now()+delay<deadlineAt&&!context.signal?.aborted){
          await sleep(delay,context,id);continue;
        }
        // A contract/business rejection is local to that request, not a venue outage.
        if(publicRequest&&code!=='API_ERROR'){
          failureGeneration++;state.errorCode=code;state.retryAt=Math.max(state.retryAt??0,Date.now()+cooldown(code));
        }
        // Never repeat an order POST/DELETE; the execution layer resolves uncertain orders by ID.
        const privateValues=['apiKey','secret','password'].map(key=>own(client,key)).filter((value):value is string=>typeof value==='string');
        const failure=new ExchangeNetworkError(code,publicRequest?state.retryAt:0,exchangeApiCode(id,error),id,
          code==='API_ERROR'?safeExchangeApiMessage(id,error,privateValues):undefined);
        if(code==='API_ERROR'&&gatePostOnlyCreateRejected(error)){
          const nativeClientId=gateMakerCreateIdentity(id,url,method,body);
          if(nativeClientId)gateMakerCreateRejections.set(failure,{client,nativeClientId});
        }
        throw failure;
      }
    }
  };
}
