import ccxt from 'ccxt';
import type {ExchangeId,OrderRequest,OrderResult} from '../shared/types.js';
import type {RealtimeStreamStatus} from '../shared/realtime.js';
import {classifyNetworkError,getExchangeNetworkStatus,type NetworkCode} from './network.js';
import {bybitOrderDiagnostic,bybitOrderDiagnosticReason} from './bybit-order-diagnostics.js';
import {observeWsSendRejections} from './ws-send-observation.js';

export interface RealtimeOrderOptions {
  onStatus?:(status:RealtimeStreamStatus)=>void;
  injectedWsClient?:any;
  accountMode?:'classic'|'unified';
}
/** Frozen facts from the actual submitted payload, not a fresh account-mode guess. */
export interface RealtimeOrderIdentity {positionIdx?:number;posSide?:'long'|'short'|'net';marginMode?:'cross'|'isolated';positionId?:string;limitPrice?:number}
interface Registration {request:OrderRequest;nativeClientId:string;contractSize:number;at:number;signature:string;identity:RealtimeOrderIdentity;invalid?:boolean}
type Evidence=Partial<Record<'amount'|'price'|'type'|'tif'|'reduce'|'nativeReduce'|'id'|'client'|'symbol'|'side'|'idx'|'posSide'|'holdSide'|'holdMode'|'margin'|'pid'|'action'|'category'|'trigger'|'close'|'autoSize'|'conditional',unknown[]>>;
interface NativeOrder {id:string;clientId?:string;symbol:string;side:string;status:string;filled:number;timestamp:number;fee?:number;foreignFee:boolean;rejectionCode?:string;evidence:Evidence;fullyFilled?:boolean;executionValue?:unknown;executionConflict?:boolean}
interface NativeTrade {id:string;orderId?:string;clientId?:string;symbol:string;side:string;amount:number;price:number;timestamp:number;fee?:number;foreignFee:boolean;evidence:Evidence}
type PrivateFailureStage='initialization'|'orders'|'trades'|'socket-error'|'socket-close'|'send';
interface PrivateFailure {failureCode:NetworkCode|'SOCKET_CLOSED';failureStage:PrivateFailureStage;closeCode?:number}
const failureCodes=new Set<NetworkCode>(['REGION_BLOCKED','ACCESS_DENIED','PROXY_UNAVAILABLE','RATE_LIMITED','TIMEOUT','DNS_ERROR','TLS_ERROR','NETWORK_ERROR','API_ERROR']);
const MAX_RECORDS=512,MAX_TRADES=4096,MAX_SYMBOLS=256,MAX_AGE_MS=30*60_000;
const terminal=new Set(['closed','canceled','cancelled','expired','rejected']);
const numeric=(value:unknown):number|undefined=>typeof value==='number'?Number.isFinite(value)?value:undefined:
  typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value))?Number(value):undefined;
const identifier=(value:unknown):string|undefined=>typeof value==='string'&&value.length>0&&value.length<=256?value:
  typeof value==='number'&&Number.isSafeInteger(value)?String(value):undefined;
const nativeClient=(row:any)=>identifier(row.clientOrderId)??identifier(row.info?.clientOid)??identifier(row.info?.orderLinkId)??
  identifier(row.info?.clOrdId)??identifier(row.info?.c)??identifier(row.info?.text);
const closeEnough=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-10,Math.max(Math.abs(a),Math.abs(b))*1e-8);
const signature=(r:OrderRequest)=>JSON.stringify([r.symbol,r.side,r.quantity,r.limitPrice,r.reduceOnly,r.postOnly??false,r.closePosition??null]);
const lower=(value:unknown)=>typeof value==='string'?value.toLowerCase():value;
const bool=(value:unknown):boolean|undefined=>value===true||value==='true'||value==='YES'||value==='yes'?true:
  value===false||value==='false'||value==='NO'||value==='no'?false:undefined;
const margin=(value:unknown)=>value==='crossed'?'cross':value;
const position=(value:unknown)=>value==='BOTH'||value==='both'?'net':lower(value);
const mergeEvidence=(prior:Evidence|undefined,next:Evidence):Evidence=>{
  const merged:Evidence={...prior};
  for(const [key,values] of Object.entries(next)){
    const combined=[...new Set([...(prior?.[key as keyof Evidence]??[]),...values])];
    // Bounded contradictory duplicates remain invalid; never drop the later contradiction.
    merged[key as keyof Evidence]=combined.length>8?[...combined.slice(0,7),null]:combined;
  }
  return merged;
};

/** Private push events only accelerate confirmation. They never create, cancel or amend an order.
 * A terminal order plus complete identified fills and actual USDT fees are required; otherwise
 * callers must continue their existing REST lookup of the original native/client order id. */
export class RealtimeOrderEvents {
  private desired=new Set<string>();
  private registrations=new Map<string,Registration>();
  private orders=new Map<string,NativeOrder>();
  private trades=new Map<string,NativeTrade>();
  // Positive original-order execution is exposure evidence even before it can be priced.
  private executionWitnesses=new Map<string,{symbol:string;orderId?:string;clientId?:string;timestamp:number}>();
  private ws?:any;
  private generation=0;
  private running=false;
  private closed=false;
  private orderReady=false;
  private tradeReady=false;
  private retry?:ReturnType<typeof setTimeout>;
  private closing:Promise<void>=Promise.resolve();
  private waiters=new Set<()=>void>();
  private stream:RealtimeStreamStatus;
  constructor(readonly id:ExchangeId,private readonly restClient:any,private readonly options:RealtimeOrderOptions={}) {
    this.stream={exchange:id,kind:'private',state:'disabled',subscriptions:0,lastEventAt:0,reconnects:0};
  }
  status():RealtimeStreamStatus{return {...this.stream};}
  private publish(state:RealtimeStreamStatus['state'],error?:string,failure?:PrivateFailure){
    this.stream={...this.stream,state,subscriptions:this.running?2:0,...(error?{error}:{error:undefined}),
      failureCode:failure?.failureCode,failureStage:failure?.failureStage,closeCode:failure?.closeCode};
    try{this.options.onStatus?.(this.status());}catch{/* Observability cannot interrupt order reconciliation. */}
  }
  private failure(error:unknown,stage:PrivateFailureStage):PrivateFailure {
    if(stage==='socket-close'){
      let closeCode:unknown;try{closeCode=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined;}catch{/* Never invoke a close diagnostic getter. */}
      return {failureCode:'SOCKET_CLOSED',failureStage:stage,
        ...(typeof closeCode==='number'&&Number.isInteger(closeCode)&&closeCode>=1000&&closeCode<=4999?{closeCode}:{})};
    }
    let code:NetworkCode='NETWORK_ERROR';
    try{
      const proxy=getExchangeNetworkStatus(this.restClient)?.route==='proxy'||Boolean(this.restClient.socksProxy??this.restClient.socks_proxy??
        this.restClient.httpsProxy??this.restClient.https_proxy??this.restClient.httpProxy??this.restClient.http_proxy??this.restClient.proxyUrl);
      const classified=classifyNetworkError(error,proxy);if(failureCodes.has(classified))code=classified;
    }catch{/* Diagnostic inspection cannot change the original recovery path. */}
    return {failureCode:code,failureStage:stage};
  }
  setSymbols(symbols:string[]):void {
    if(this.closed)return;
    this.desired=new Set(symbols.filter(s=>typeof s==='string'&&s.length<=100&&s.endsWith('/USDT:USDT')).slice(0,MAX_SYMBOLS));
    this.prune();
    if(!this.desired.size){this.stop();this.publish('disabled');return;}
    if(!this.running&&!this.retry)this.start();
  }
  observe(request:OrderRequest,nativeClientId:string,contractSize:number,identity:RealtimeOrderIdentity={}):void {
    if(this.closed||!identifier(request.clientOrderId)||!identifier(nativeClientId)||!Number.isFinite(contractSize)||contractSize<=0)return;
    const prior=this.registrations.get(request.clientOrderId);
    if(prior&&(prior.signature!==signature(request)||prior.nativeClientId!==nativeClientId||prior.contractSize!==contractSize)){
      prior.invalid=true;return;
    }
    const registered=prior??{request:{...request},nativeClientId,contractSize,at:Date.now(),signature:signature(request),identity:{}};
    // The ACK may arrive after the WS event. Enrich this same registration without resetting
    // its observation time, reconnecting, or dropping already received order/fill evidence.
    for(const key of ['positionIdx','posSide','marginMode','positionId','limitPrice'] as const){
      const value=identity[key];if(value===undefined)continue;
      if(key==='positionIdx'&&(!Number.isInteger(value)||![0,1,2].includes(Number(value)))||
        key==='posSide'&&!['net','long','short'].includes(String(value))||
        key==='marginMode'&&!['cross','isolated'].includes(String(value))||
        key==='positionId'&&identifier(value)!==value||key==='limitPrice'&&(!(typeof value==='number')||!Number.isFinite(value)||value<=0)){registered.invalid=true;continue;}
      if(registered.identity[key]!==undefined&&registered.identity[key]!==value)registered.invalid=true;
      else (registered.identity as any)[key]=value;
    }
    if(!prior)this.registrations.set(request.clientOrderId,registered);
    this.prune();
    if(!this.desired.has(request.symbol))this.setSymbols([...this.desired,request.symbol]);
    else if(!this.running&&!this.retry)this.start();
    this.notify();
  }
  private createClient():any {
    const injected=this.options.injectedWsClient;
    const name=this.id==='binance'?'binanceusdm':this.id;
    const Constructor=(ccxt as any).pro?.[name];
    if(!injected&&typeof Constructor!=='function')throw new Error('WS_UNSUPPORTED');
    const rest=this.restClient;
    const socks=rest.socksProxy??rest.socks_proxy;
    const http=rest.httpsProxy??rest.https_proxy??rest.httpProxy??rest.http_proxy;
    const route=getExchangeNetworkStatus(rest)?.route;
    const ws=injected??new Constructor({apiKey:rest.apiKey,secret:rest.secret,password:rest.password,uid:rest.uid,
      enableRateLimit:true,timeout:rest.timeout??8000,newUpdates:true,
      // Keep an authenticated, quiet Binance connection active on the selected proxy.
      // This native control heartbeat is independent of business-event and quote freshness.
      ...(this.id==='binance'&&(route==='proxy'||socks||http)?{streaming:{keepAlive:15000}}:{}),
      options:{...rest.options,defaultType:'swap',defaultSubType:'linear',defaultSettle:'USDT',
        ordersLimit:MAX_RECORDS,tradesLimit:MAX_TRADES,watchMyTrades:{...rest.options?.watchMyTrades,execType:['Trade'],executionFast:false}}});
    // Market sharing avoids a second loader and preserves the app's USDT contract-size metadata.
    if(!rest.markets)throw new Error('WS_MARKETS_PENDING');
    if(typeof ws.setMarketsFromExchange==='function')ws.setMarketsFromExchange(rest);
    else for(const key of ['markets','markets_by_id','symbols','ids','currencies','currencies_by_id'])ws[key]=rest[key];
    if((route==='proxy'||rest.proxyUrl)&&!socks&&!http&&!rest.agent)throw new Error('WS_PROXY_UNAVAILABLE');
    // CCXT uses distinct proxy fields for HTTPS requests and secure WebSockets. No direct fallback.
    for(const field of ['httpProxy','httpsProxy','socksProxy','wsProxy','wssProxy','wsSocksProxy'])ws[field]=undefined;
    if(socks){ws.socksProxy=socks;ws.wsSocksProxy=socks;}
    else if(http){ws.httpsProxy=http;ws.wssProxy=http;}
    if(rest.agent)ws.agent=rest.agent;
    // Listen-key/UID/time reads use the already configured application transport, including its proxy.
    if(!injected&&typeof rest.fetch==='function')ws.fetch=rest.fetch.bind(rest);
    if(this.id==='gate')ws.options={...ws.options,ws:{...ws.options?.ws,options:{...ws.options?.ws?.options,
      headers:{...ws.options?.ws?.options?.headers,'X-Gate-Size-Decimal':'1'}}}};
    const generation=this.generation+1;
    observeWsSendRejections(ws,{isCurrent:()=>!this.closed&&this.running&&this.ws===ws&&generation===this.generation,
      onFailure:()=>this.failed(generation,undefined,'send')});
    return ws;
  }
  private params():Record<string,unknown>{
    const params:Record<string,unknown>={type:'swap',subType:'linear',settle:'USDT'};
    if(this.id==='bitget'){
      const mode=this.options.accountMode??(typeof this.restClient.options?.uta==='boolean'?this.restClient.options.uta?'unified':'classic':undefined);
      if(!mode)throw new Error('WS_ACCOUNT_MODE_PENDING');
      params.uta=mode==='unified';
    }
    return params;
  }
  private start(){
    if(this.closed||this.running||!this.desired.size)return;
    let ws:any,params:Record<string,unknown>;
    try{params=this.params();ws=this.createClient();}
    catch(error){this.publish('degraded','私有推送尚未就绪，继续按原订单编号核对',this.failure(error,'initialization'));return;}
    this.orders.clear();this.trades.clear();this.executionWitnesses.clear();
    this.ws=ws;this.running=true;this.orderReady=false;this.tradeReady=false;
    const generation=++this.generation;this.publish('connecting');
    this.attachReadiness(ws,generation);
    void (async()=>{
      try{
        if(typeof ws.loadProxyModules==='function')await ws.loadProxyModules();
        // Gate futures private subscriptions need the authenticated account UID in their payload.
        // Obtain it with the existing signed GET transport; never infer it from the API key.
        if(this.id==='gate'&&!identifier(ws.uid)){
          if(typeof this.restClient.privateFuturesGetSettleAccounts!=='function')throw new Error('WS_UID_PENDING');
          const account=await this.restClient.privateFuturesGetSettleAccounts({settle:'usdt'});
          const uid=identifier(account?.user);
          if(!uid||!/^\d+$/.test(uid)||Number(uid)<=0)throw new Error('WS_UID_PENDING');
          ws.uid=uid;
        }
      }
      catch(error){this.failed(generation,error,'initialization');return;}
      if(generation!==this.generation||this.closed)return;
      void this.watch('orders',ws,generation,params);void this.watch('trades',ws,generation,params);
    })();
  }
  private markReady(kind:'orders'|'trades'|'both',generation:number){
    if(this.closed||!this.running||generation!==this.generation)return;
    if(kind!=='trades')this.orderReady=true;if(kind!=='orders')this.tradeReady=true;
    this.stream.lastEventAt=Date.now();this.publish(this.orderReady&&this.tradeReady?'online':'connecting');this.notify();
  }
  private attachReadiness(ws:any,generation:number){
    // A quiet private fill channel may have no initial snapshot. Native subscription ACKs only
    // mark its availability; they never enter the terminal-order or actual-fill caches.
    const originalMessage=ws.handleMessage;
    if(typeof originalMessage==='function')ws.handleMessage=(client:any,message:any)=>{
      if(generation===this.generation&&!this.closed)this.subscriptionReady(client,message,generation);
      return originalMessage.call(ws,client,message);
    };
    const originalConnected=ws.onConnected;
    if(typeof originalConnected==='function')ws.onConnected=(client:any,message:any)=>{
      const result=originalConnected.call(ws,client,message);
      // Binance listen-key user streams have no separate subscribe response.
      if(this.id==='binance'){
        const key=ws.options?.future?.listenKey;
        if(typeof key==='string'&&key&&typeof client?.url==='string'&&client.url.includes(key))this.markReady('both',generation);
      }
      return result;
    };
    for(const name of ['onError','onClose']){
      const original=ws[name];
      if(typeof original==='function')ws[name]=(client:any,error:any)=>{
        try{return original.call(ws,client,error);}finally{this.failed(generation,error,name==='onClose'?'socket-close':'socket-error');}
      };
    }
  }
  private subscriptionReady(client:any,message:any,generation:number){
    if(!message||typeof message!=='object'||message.error||message.event==='error')return;
    if(this.id==='bybit'&&message.op==='subscribe'&&message.success===true){
      const requestId=identifier(message.req_id);if(!requestId)return;
      for(const sub of Object.values(client?.subscriptions??{}) as any[]){
        if(identifier(sub?.id)!==requestId||!Array.isArray(sub?.topics))continue;
        if(sub.topics.includes('order')||sub.topics.includes('order.linear'))this.markReady('orders',generation);
        if(sub.topics.includes('execution')||sub.topics.includes('execution.linear'))this.markReady('trades',generation);
      }
    }else if(this.id==='gate'&&message.event==='subscribe'&&message.result?.status==='success'){
      if(message.channel==='futures.orders')this.markReady('orders',generation);
      else if(message.channel==='futures.usertrades')this.markReady('trades',generation);
    }else if(this.id==='okx'&&message.event==='subscribe'&&message.arg?.channel==='orders'&&message.arg?.instType==='SWAP'){
      this.markReady('both',generation); // OKX delivers order and execution updates on the same channel.
    }else if(this.id==='bitget'&&message.event==='subscribe'){
      const arg=message.arg,mode=this.params().uta?'UTA':'USDT-FUTURES';
      if(arg?.instType!==mode)return;
      const channel=arg.topic??arg.channel;
      if(channel==='order'||channel==='orders')this.markReady('orders',generation);
      else if(channel==='fill')this.markReady('trades',generation);
    }
  }
  private async watch(kind:'orders'|'trades',ws:any,generation:number,params:Record<string,unknown>){
    try{
      const method=kind==='orders'?'watchOrders':'watchMyTrades';
      if(typeof ws[method]!=='function')throw new Error('WS_UNSUPPORTED');
      while(this.running&&!this.closed&&generation===this.generation){
        const rows=await ws[method](undefined,undefined,undefined,{...params});
        if(this.closed||generation!==this.generation)return;
        if(!Array.isArray(rows))continue; // Auth/subscription acknowledgements are not execution evidence.
        if(kind==='orders')this.orderReady=true;else this.tradeReady=true;
        this.stream.lastEventAt=Date.now();
        for(const row of rows.slice(-MAX_TRADES))if(kind==='orders')this.ingestOrder(row);else this.ingestTrade(row);
        this.prune();this.publish(this.orderReady&&this.tradeReady?'online':'connecting');this.notify();
      }
    }catch(error){this.failed(generation,error,kind);}
  }
  private failed(generation:number,error:unknown,stage:PrivateFailureStage){
    if(this.closed||generation!==this.generation)return;
    const failure=stage==='send'?{failureCode:'NETWORK_ERROR' as const,failureStage:stage}:this.failure(error,stage);
    if(this.closed||generation!==this.generation)return;
    this.stop();this.orders.clear();this.trades.clear();this.executionWitnesses.clear();this.stream.reconnects++;
    this.publish('degraded','私有推送断开，继续按原订单编号核对',failure);this.notify();
    this.retry=setTimeout(()=>{this.retry=undefined;this.start();},1500);this.retry.unref?.();
  }
  private stop(){
    this.running=false;this.generation++;this.orderReady=false;this.tradeReady=false;
    const prior=this.ws;this.ws=undefined;
    try{if(prior?.close)this.closing=Promise.all([this.closing,Promise.resolve(prior.close()).catch(()=>{})]).then(()=>{});}catch{/* Closing a stream cannot send an order. */}
    this.notify();
  }
  private fees(row:any,cumulative=false):{fee?:number;foreignFee:boolean}{
    const info=row.info??{};
    // Current Bybit execution.currency is not consumed by some CCXT versions; do not let
    // their inferred USDT settlement currency conceal a real MNT fee or an extra tax currency.
    if(info.feeCurrency&&info.feeCurrency!=='USDT')return {foreignFee:true};
    if(!cumulative&&info.extraFees!==undefined&&info.extraFees!==null&&info.extraFees!==''&&!Array.isArray(info.extraFees))return {foreignFee:true};
    if(!cumulative&&Array.isArray(info.extraFees)&&info.extraFees.some((extra:any)=>extra?.feeCoin!=='USDT'))return {foreignFee:true};
    const hasExtraFees=!cumulative&&Array.isArray(info.extraFees)&&info.extraFees.length>0;
    if(hasExtraFees&&info.extraFees.some((extra:any)=>numeric(extra?.fee)===undefined))return {foreignFee:true};
    let entries:any[]|undefined;
    if(Array.isArray(info.feeDetail)&&info.feeDetail.length)entries=info.feeDetail.map((f:any)=>({currency:f.feeCoin,
      cost:numeric(f.fee)??(numeric(f.totalFee)===undefined?undefined:-Number(f.totalFee))}));
    else if(cumulative&&this.id==='bybit'&&info.cumFeeDetail&&typeof info.cumFeeDetail==='object')
      entries=Object.entries(info.cumFeeDetail).map(([currency,cost])=>({currency,cost}));
    else if(!cumulative||(this.id==='okx'&&info.fee!==undefined))
      entries=Array.isArray(row.fees)&&row.fees.length?row.fees:row.fee?[row.fee]:undefined;
    // A cumulative trading-fee field is not proof that a separate tax was included. Missing
    // per-fill evidence with an explicit extra tax therefore needs the original-ID REST lookup.
    if(!entries?.length)return {foreignFee:!cumulative&&Array.isArray(info.extraFees)&&info.extraFees.length>0};
    if(entries.some(f=>f?.currency!=='USDT'))return {foreignFee:true};
    if(entries.some(f=>numeric(f?.cost)===undefined))return {foreignFee:hasExtraFees};
    let fee=entries.reduce((sum,f)=>sum+Number(f.cost),0);
    if(!cumulative&&Array.isArray(info.extraFees))for(const extra of info.extraFees){
      if(extra.feeCoin!=='USDT')return {foreignFee:true};
      const cost=numeric(extra.fee);if(cost===undefined)return {foreignFee:true};fee+=cost;
    }
    return Number.isFinite(fee)?{fee,foreignFee:false}:{foreignFee:false};
  }
  private identityEvidence(row:any,trade=false):Evidence {
    const info=row.info??{},e:Evidence={};
    const add=(key:keyof Evidence,...values:unknown[])=>{const present=values.filter(v=>v!==undefined&&v!==null);if(present.length)e[key]=present;};
    add('id',trade?row.order:row.id);add('client',row.clientOrderId);
    add('side',lower(row.side));add('type',lower(row.type));add('tif',lower(row.timeInForce));add('reduce',row.reduceOnly);
    if(!trade){add('amount',row.amount);add('price',row.price);}
    add('trigger',row.triggerPrice,row.stopPrice);
    if(this.id==='bybit'){
      add('id',trade?row.order:row.id,info.orderId);add('client',row.clientOrderId,info.orderLinkId);
      add('symbol',info.symbol);add('side',lower(row.side),lower(info.side));add('type',lower(row.type),lower(info.orderType));
      add('tif',lower(row.timeInForce),lower(info.timeInForce));add('nativeReduce',info.reduceOnly);add('idx',info.positionIdx);
      add('category',lower(info.category));add('trigger',row.triggerPrice,row.stopPrice,info.triggerPrice);
      add('conditional',info.stopOrderType);add('close',info.closeOnTrigger);
      if(!trade){add('amount',row.amount,info.qty);add('price',row.price,info.price);}
      else {add('amount',info.orderQty);add('price',info.orderPrice);}
    }else if(this.id==='binance'){
      add('id',trade?row.order:row.id,info.i);add('client',row.clientOrderId,info.c);
      add('symbol',info.s);add('side',lower(row.side),lower(info.S));add('type',lower(row.type),lower(info.o));
      add('tif',lower(row.timeInForce),lower(info.f));add('nativeReduce',info.R);add('posSide',info.ps,info.positionSide);
      add('trigger',row.triggerPrice,row.stopPrice,info.sp,info.P);add('close',info.cp);
      if(info.ot!==undefined)add('type',lower(row.type),lower(info.o),lower(info.ot));
      if(!trade){add('amount',row.amount,info.q);add('price',row.price,info.p);}
    }else if(this.id==='okx'){
      add('id',trade?row.order:row.id,info.ordId);add('client',row.clientOrderId,info.clOrdId);add('symbol',info.instId);
      add('side',lower(row.side),lower(info.side));add('nativeReduce',info.reduceOnly);add('posSide',info.posSide);add('margin',info.tdMode);
      const nativeType=lower(info.ordType);
      add('type',lower(row.type),nativeType===undefined?undefined:nativeType==='ioc'?'limit':nativeType);
      add('tif',lower(row.timeInForce),nativeType===undefined?undefined:nativeType==='ioc'?'ioc':nativeType==='limit'?'gtc':nativeType);
      if(!trade){add('amount',row.amount,info.sz);add('price',row.price,info.px);}
    }else if(this.id==='gate'){
      add('id',trade?row.order:row.id,trade?info.order_id:info.id);add('client',row.clientOrderId,info.text);add('symbol',info.contract);
      const size=numeric(info.size);
      add('side',lower(row.side),size===undefined||size===0?undefined:size>0?'buy':'sell');
      add('nativeReduce',info.is_reduce_only,info.reduce_only);add('tif',lower(row.timeInForce),lower(info.tif));
      add('margin',info.pos_margin_mode);add('pid',info.pid);add('close',info.is_close,info.close,info.is_liq);add('autoSize',info.auto_size);
      if(!trade){add('amount',row.amount,size===undefined?info.size:Math.abs(size));add('price',row.price,info.price);}
    }else if(this.id==='bitget'){
      add('id',trade?row.order:row.id,info.orderId);add('client',row.clientOrderId,info.clientOid);add('symbol',info.symbol,info.instId);
      add('side',lower(row.side),lower(info.side));add('type',lower(row.type),lower(info.orderType));
      add('tif',lower(row.timeInForce),lower(info.timeInForce),lower(info.force));add('nativeReduce',info.reduceOnly);
      add('posSide',info.posSide);add('holdSide',info.holdSide);add('holdMode',info.holdMode,info.posMode);add('action',info.tradeSide);
      add('margin',info.marginMode);add('category',lower(info.category));
      add('conditional',info.delegateType);add('trigger',row.triggerPrice,row.stopPrice,info.triggerPrice);
      if(!trade){add('amount',row.amount,info.qty,info.size);add('price',row.price,info.price);}
    }
    return e;
  }
  private identityMatches(e:Evidence,registered:Registration,orderId:string,trade=false):boolean {
    const r=registered.request,expected=registered.identity;
    const all=(key:keyof Evidence,check:(v:unknown)=>boolean,required=false)=>
      (!required||!!e[key]?.length)&&(e[key]??[]).every(check);
    const marketId=identifier(this.restClient.markets?.[r.symbol]?.id);
    if(!all('id',v=>identifier(v)===orderId,!trade)||trade&&!e.id?.length&&!e.client?.length||!all('client',v=>identifier(v)===registered.nativeClientId)||
      !all('symbol',v=>identifier(v)===marketId)||!all('side',v=>v===r.side,true)||
      !all('type',v=>v==='limit',!trade)||!all('tif',v=>v==='ioc',!trade)||
      !all('trigger',v=>v===''||numeric(v)===0)||!all('close',v=>bool(v)===false)||!all('autoSize',v=>v==='')||
      !all('conditional',v=>v===''||v==='UNKNOWN'||this.id==='bitget'&&v==='normal'))return false;
    if(!all('amount',v=>numeric(v)!==undefined&&closeEnough(Number(v)*registered.contractSize,r.quantity),!trade)||
      !all('price',v=>numeric(v)!==undefined&&Number(v)>0&&(expected.limitPrice!==undefined?Math.abs(Number(v)-expected.limitPrice)<=Math.max(1e-12,Math.abs(expected.limitPrice)*1e-12):
        r.side==='buy'?Number(v)<=r.limitPrice+1e-12:Number(v)>=r.limitPrice-1e-12),!trade))return false;
    const desiredSide=r.reduceOnly?r.side==='buy'?'short':'long':r.side==='buy'?'long':'short';
    const hedge=this.id==='bitget'&&expected.posSide!==undefined&&expected.posSide!=='net';
    // Bitget hedge mode represents the reduction through its position side and tradeSide;
    // its native reduceOnly=no does not mean that a hedge close opens a fresh position.
    const reduction=(v:unknown)=>bool(v)===r.reduceOnly||(hedge&&r.reduceOnly&&bool(v)===false);
    if(!all('reduce',reduction)||!all('nativeReduce',reduction)||
      !trade&&!hedge&&!(e.reduce?.length||e.nativeReduce?.length))return false;
    if(this.id==='bybit'){
      const idx=expected.positionIdx;
      if(!Number.isInteger(idx)||![0,desiredSide==='long'?1:2].includes(idx!)||
        !all('idx',v=>numeric(v)===idx,!trade)||!all('category',v=>v==='linear'))return false;
    }else if(this.id==='binance'||this.id==='okx'){
      if(expected.posSide===undefined||!all('posSide',v=>position(v)===expected.posSide,!trade))return false;
    }else if(this.id==='bitget'){
      if(expected.posSide===undefined||!all('holdMode',v=>v===(hedge?'hedge_mode':'one_way_mode'),!trade)||
        !all('posSide',v=>position(v)===expected.posSide||!hedge&&position(v)===desiredSide)||!all('holdSide',v=>position(v)===desiredSide)||
        !all('action',v=>v===(r.reduceOnly?'close':'open')||v===`${r.reduceOnly?'close':'open'}_${desiredSide}`,!trade&&hedge)||
        !all('category',v=>v==='usdt-futures'))return false;
      if(!trade&&hedge&&!(e.posSide?.length||e.holdSide?.length))return false;
    }
    // A dual-plus Gate selector or actual margin mode must be proved by the native event;
    // absent fields go back to strict original-ID REST instead of weakening its validation.
    if(!all('margin',v=>expected.marginMode!==undefined&&margin(v)===expected.marginMode,!trade&&expected.marginMode!==undefined)||
      !all('pid',v=>expected.positionId!==undefined&&identifier(v)===expected.positionId,!trade&&expected.positionId!==undefined))return false;
    return true;
  }
  private ingestOrder(row:any){
    if(!row||!this.desired.has(row.symbol)||!['buy','sell'].includes(row.side))return;
    const id=identifier(row.id),filled=numeric(row.filled),timestamp=numeric(row.lastTradeTimestamp)??numeric(row.timestamp);
    if(!id||filled===undefined||filled<0||timestamp===undefined||timestamp<=0)return;
    const key=JSON.stringify([row.symbol,row.side,id]),prior=this.orders.get(key);
    if(prior&&(timestamp<prior.timestamp||filled<prior.filled||terminal.has(prior.status)&&!terminal.has(row.status)))return;
    const fees=this.fees(row,true);
    const diagnostic=this.id==='bybit'?bybitOrderDiagnostic({orderStatus:row.info?.orderStatus??row.status,
      rejectReason:row.info?.rejectReason,cancelType:row.info?.cancelType},filled,false,prior?.rejectionCode):undefined;
    const sameQuantity=prior!==undefined&&closeEnough(prior.filled,filled),fullyFilled=this.id==='bybit'&&row.info?.orderStatus==='Filled'||sameQuantity&&prior?.fullyFilled;
    const executionValue=this.id==='bybit'&&row.info?.cumExecValue!==undefined?row.info.cumExecValue:sameQuantity?prior?.executionValue:undefined;
    const total=numeric(row.amount)??numeric(row.info?.qty);
    const executionConflict=prior?.executionConflict||!!fullyFilled&&total!==undefined&&!closeEnough(total,filled)||
      sameQuantity&&prior.executionValue!==undefined&&executionValue!==undefined&&
      (numeric(prior.executionValue)===undefined||numeric(executionValue)===undefined||
        Math.abs(Number(prior.executionValue)-Number(executionValue))>Math.max(1e-8,Math.abs(Number(executionValue))*1e-8));
    this.orders.set(key,{id,clientId:nativeClient(row),symbol:row.symbol,side:row.side,status:row.status,filled,timestamp,...fees,
      evidence:mergeEvidence(prior?.evidence,this.identityEvidence(row)),
      fullyFilled,executionValue,executionConflict,
      ...(diagnostic?{rejectionCode:diagnostic.rejectionCode}:{})});
    for(const trade of Array.isArray(row.trades)?row.trades:[])this.ingestTrade(trade);
  }
  private ingestTrade(row:any){
    if(!row||!this.desired.has(row.symbol)||!['buy','sell'].includes(row.side)||
      row.info?.execType&&row.info.execType!=='Trade')return;
    const id=identifier(row.id),orderId=identifier(row.order),clientId=nativeClient(row);
    const amount=numeric(row.amount),price=numeric(row.price),timestamp=numeric(row.timestamp);
    if((orderId||clientId)&&amount!==undefined&&amount>0&&timestamp!==undefined&&timestamp>0){
      const witnessKey=JSON.stringify([row.symbol,orderId??clientId]);
      if(timestamp>=(this.executionWitnesses.get(witnessKey)?.timestamp??0))this.executionWitnesses.set(witnessKey,{symbol:row.symbol,orderId,clientId,timestamp});
    }
    if(!id||(!orderId&&!clientId)||amount===undefined||amount<=0||price===undefined||price<=0||timestamp===undefined||timestamp<=0)return;
    const key=JSON.stringify([row.symbol,row.side,orderId??clientId,id]),prior=this.trades.get(key),fees=this.fees(row);
    if(prior){
      prior.evidence=mergeEvidence(prior.evidence,this.identityEvidence(row,true));
      // Duplicate fills may gain missing fee metadata, never gain a second quantity or fee.
      if(!closeEnough(prior.amount,amount)||!closeEnough(prior.price,price)){
        prior.foreignFee=true;prior.fee=undefined;return;
      }
      // Two known cash amounts for one execution cannot both be authoritative.
      // Keep this evidence unresolved so the exact original order is read via REST.
      if(prior.fee!==undefined&&fees.fee!==undefined&&
        Math.abs(prior.fee-fees.fee)>Math.max(1e-12,Math.max(Math.abs(prior.fee),Math.abs(fees.fee))*1e-10)){
        prior.foreignFee=true;prior.fee=undefined;return;
      }
      if(prior.fee===undefined&&fees.fee!==undefined&&!prior.foreignFee)this.trades.set(key,{...prior,...fees});
      if(fees.foreignFee)prior.foreignFee=true;
      return;
    }
    this.trades.set(key,{id,orderId,clientId,symbol:row.symbol,side:row.side,amount,price,timestamp,...fees,evidence:this.identityEvidence(row,true)});
  }
  result(request:OrderRequest,orderId?:string):OrderResult|undefined {
    if(this.closed||!this.running)return;
    const registered=this.registrations.get(request.clientOrderId);
    if(!registered||registered.invalid||registered.signature!==signature(request)||request.postOnly||request.closePosition)return;
    const same=(row:NativeOrder)=>row.symbol===request.symbol&&row.side===request.side&&
      row.timestamp>=registered.at-1000&&(!row.clientId||row.clientId===registered.nativeClientId)&&
      (orderId?row.id===orderId:row.clientId===registered.nativeClientId);
    const matches=[...this.orders.values()].filter(same);if(matches.length!==1)return;
    const order=matches[0];if(!terminal.has(order.status)||!this.identityMatches(order.evidence,registered,order.id))return;
    const filled=order.filled*registered.contractSize;
    if(!Number.isFinite(filled)||filled>request.quantity&&!closeEnough(filled,request.quantity))return;
    if(order.executionConflict||order.fullyFilled&&!closeEnough(filled,request.quantity)||order.executionValue!==undefined&&numeric(order.executionValue)===undefined){order.executionConflict=true;return;}
    const trades=[...this.trades.values()].filter(t=>t.symbol===request.symbol&&t.side===request.side&&t.timestamp>=registered.at-1000&&
      (t.orderId?t.orderId===order.id:t.clientId===registered.nativeClientId)&&(!t.clientId||t.clientId===registered.nativeClientId));
    if(filled===0){
      // An execution for this original ID contradicts a zero cumulative receipt.
      // Never erase a known fill because the order and execution channels disagree.
      if(order.status==='closed'||trades.length||order.executionValue!==undefined&&Number(order.executionValue)!==0||
        [...this.executionWitnesses.values()].some(t=>t.symbol===request.symbol&&t.timestamp>=registered.at-1000&&
          (t.orderId?t.orderId===order.id:t.clientId===registered.nativeClientId)))return;
      const reason=this.id==='bybit'?bybitOrderDiagnosticReason(order.rejectionCode,request.reduceOnly):undefined;
      return {id:order.id,clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:order.timestamp,averagePriceVerified:true,
        ...(reason?{rejectionCode:order.rejectionCode,rejectionReason:reason}:{})};
    }
    const quantity=trades.reduce((sum,t)=>sum+t.amount*registered.contractSize,0);
    if(!trades.length||!closeEnough(quantity,filled)||order.foreignFee||trades.some(t=>t.foreignFee||!this.identityMatches(t.evidence,registered,order.id,true)))return;
    const submittedPrice=registered.identity.limitPrice??request.limitPrice;
    const priceTolerance=Math.max(1e-12,Math.abs(submittedPrice)*1e-12);
    if(!Number.isFinite(submittedPrice)||submittedPrice<=0||trades.some(t=>request.side==='buy'
      ?t.price>submittedPrice+priceTolerance:t.price<submittedPrice-priceTolerance))return;
    const completeFees=trades.every(t=>t.fee!==undefined),fee=completeFees?trades.reduce((sum,t)=>sum+t.fee!,0):order.fee;
    const average=trades.reduce((sum,t)=>sum+t.amount*registered.contractSize*t.price,0)/quantity;
    if(order.executionValue!==undefined&&Math.abs(Number(order.executionValue)-quantity*average)>Math.max(1e-8,Math.abs(quantity*average)*1e-8)){order.executionConflict=true;return;}
    if(fee===undefined||!Number.isFinite(fee)||!Number.isFinite(average)||average<=0)return;
    return {id:order.id,clientOrderId:request.clientOrderId,status:closeEnough(filled,request.quantity)?'filled':'partial',
      filledQuantity:filled,averagePrice:average,feeUsd:fee,timestamp:Math.max(order.timestamp,...trades.map(t=>t.timestamp)),averagePriceVerified:true};
  }
  async wait(request:OrderRequest,orderId?:string,timeoutMs=150):Promise<OrderResult|undefined>{
    const ready=this.result(request,orderId);if(ready)return ready;
    if(this.closed||!this.running||!this.orderReady||!this.tradeReady)return;
    const delay=Math.min(250,Math.max(0,Number.isFinite(timeoutMs)?timeoutMs:150));if(delay===0)return;
    const generation=this.generation;
    return new Promise(resolve=>{
      let timer:ReturnType<typeof setTimeout>;
      const finish=(value:OrderResult|undefined)=>{clearTimeout(timer);this.waiters.delete(check);resolve(value);};
      const check=()=>{if(this.closed||generation!==this.generation)finish(undefined);else {const result=this.result(request,orderId);if(result)finish(result);}};
      timer=setTimeout(()=>finish(undefined),delay);this.waiters.add(check);check();
    });
  }
  private notify(){for(const fn of [...this.waiters])fn();}
  private prune(){
    const cutoff=Date.now()-MAX_AGE_MS;
    for(const [key,row] of this.registrations)if(row.at<cutoff)this.registrations.delete(key);
    for(const [key,row] of this.orders)if(row.timestamp<cutoff)this.orders.delete(key);
    for(const [key,row] of this.trades)if(row.timestamp<cutoff)this.trades.delete(key);
    for(const [key,row] of this.executionWitnesses)if(row.timestamp<cutoff)this.executionWitnesses.delete(key);
    while(this.registrations.size>MAX_RECORDS)this.registrations.delete(this.registrations.keys().next().value!);
    while(this.orders.size>MAX_RECORDS)this.orders.delete(this.orders.keys().next().value!);
    while(this.trades.size>MAX_TRADES)this.trades.delete(this.trades.keys().next().value!);
    while(this.executionWitnesses.size>MAX_TRADES)this.executionWitnesses.delete(this.executionWitnesses.keys().next().value!);
  }
  async close():Promise<void>{
    if(this.closed)return;
    this.closed=true;if(this.retry)clearTimeout(this.retry);this.retry=undefined;
    this.stop();this.registrations.clear();this.orders.clear();this.trades.clear();this.executionWitnesses.clear();this.publish('disabled');await this.closing;
  }
}
