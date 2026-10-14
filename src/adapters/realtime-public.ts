import ccxt from 'ccxt';
import type {BookLevel,ExchangeId} from '../shared/types.js';
import type {RealtimeBook,RealtimeStreamStatus} from '../shared/realtime.js';
import {classifyNetworkError,configureExchangeTransport} from './network.js';
import {isEligibleMarket} from './normalization.js';
import {observeWsSendRejections} from './ws-send-observation.js';

export const MAX_REALTIME_PUBLIC_SYMBOLS=24;
export const REALTIME_PUBLIC_BOOK_TTL_MS=2000;
const WATCHDOG_MS=250,UNSUBSCRIBE_TIMEOUT_MS=2000,CONNECT_TIMEOUT_MS=10000;
// OKX 50-level books require authenticated VIP access. The public books feed does not.
const DEPTH:Record<ExchangeId,number>={binance:20,bybit:50,okx:400,gate:100,bitget:15};
type Callbacks={onBook:(book:RealtimeBook)=>void;onStatus?:(status:RealtimeStreamStatus)=>void};
type Subscription={symbol:string;generation:number;active:boolean;startedAt:number;lastReceivedAt?:number;sequence?:bigint;eventAt?:number;fingerprint?:string;error?:string};

function sequence(value:unknown):bigint|undefined{
  if(value===undefined||value===null)return undefined;
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
  if(typeof value==='string'&&/^\d{1,30}$/.test(value))return BigInt(value);
  throw new Error('INVALID_SEQUENCE');
}
function levels(raw:unknown,multiplier:number,side:'bids'|'asks'):BookLevel[]{
  if(!Array.isArray(raw)||raw.length===0)throw new Error('EMPTY_BOOK');
  const result:BookLevel[]=[];
  for(let i=0;i<raw.length;i++){
    const row=raw[i];
    if(!Array.isArray(row)||row.length<2)throw new Error('INVALID_DEPTH');
    const price=Number(row[0]),quantity=Number(row[1])*multiplier;
    if(!Number.isFinite(price)||!Number.isFinite(quantity)||price<=0||quantity<=0)throw new Error('INVALID_DEPTH');
    if(i>0&&(side==='bids'?price>=result[i-1].price:price<=result[i-1].price))throw new Error('UNSORTED_DEPTH');
    result.push({price,quantity});
  }
  return result;
}
function copyBook(book:RealtimeBook):RealtimeBook{
  return {...book,bids:book.bids.map(level=>({...level})),asks:book.asks.map(level=>({...level}))};
}
function streamError(error:unknown,usingProxy:boolean):string{
  const code=classifyNetworkError(error,usingProxy);
  const names:Record<string,string>={TypeError:'STREAM_TYPE_ERROR',InvalidNonce:'INVALID_NONCE',ChecksumError:'CHECKSUM_ERROR',AuthenticationError:'PUBLIC_AUTH_ERROR',BadRequest:'SUBSCRIPTION_INVALID',NotSupported:'PUBLIC_STREAM_UNSUPPORTED'};
  return code==='API_ERROR'&&error instanceof Error?names[error.name]??code:code;
}
function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('STREAM_TIMEOUT')),ms);
    promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}

/** Separate, uncredentialed CCXT Pro transport. Only public order books cross this boundary.
 * CCXT performs native snapshot/delta sequence and checksum validation before watchOrderBook resolves.
 * This layer additionally rejects stale/out-of-order observations and invalidates every old generation
 * before reconnecting; a book is never refreshed merely by reading an old CCXT cache object. */
export class RealtimePublicBooks{
  private client:any;
  private desired=new Set<string>();
  private subscriptions=new Map<string,Subscription>();
  private retiring=new Map<string,Promise<void>>();
  private books=new Map<string,RealtimeBook>();
  private generation=0;
  private closed=false;
  private reconnects=0;
  private consecutiveFailures=0;
  private lastEventAt=0;
  private problem?:string;
  private restarting?:Promise<void>;
  private watchdog?:ReturnType<typeof setInterval>;
  private retryTimer?:ReturnType<typeof setTimeout>;
  private cancelRetry?:()=>void;
  private statusKey='';
  private closePromise?:Promise<void>;
  private readonly usingProxy:boolean;

  constructor(private readonly id:ExchangeId,private readonly restClient:any,private readonly callbacks:Callbacks,private readonly injectedWsClient?:any){
    if(injectedWsClient&&injectedWsClient===restClient)throw new Error('PUBLIC_CLIENT_MUST_BE_SEPARATE');
    this.usingProxy=Boolean(restClient.socksProxy??restClient.httpsProxy??restClient.httpProxy);
    this.client=this.makeClient();
  }

  private makeClient():any{
    const Constructor=(ccxt as any).pro?.[this.id==='binance'?'binanceusdm':this.id];
    if(!this.injectedWsClient&&!Constructor)throw new Error('PUBLIC_WEBSOCKET_UNSUPPORTED');
    const client=this.injectedWsClient??new Constructor({
      enableRateLimit:true,newUpdates:true,timeout:8000,has:{fetchCurrencies:false},
      options:{defaultType:'swap',defaultSubType:'linear',defaultSettle:'USDT',
        ...(this.id==='gate'?{unifiedAccount:false}:{}),
        ...(this.id==='bitget'?{uta:false}:{})},
      // Transport heartbeat is separate from the strict 2-second trading quote lifetime.
      streaming:{connectionTimeout:CONNECT_TIMEOUT_MS,keepAlive:15000,maxPingPongMisses:2},
    });
    // Never copy credentials, account options, signing implementations, or REST transport closures.
    client.apiKey=undefined;client.secret=undefined;client.password=undefined;
    client.uid=undefined;client.token=undefined;client.privateKey=undefined;
    client.verbose=false;client.newUpdates=true;
    for(const name of ['httpProxy','httpsProxy','socksProxy','wsProxy','wssProxy','wsSocksProxy','http_proxy','https_proxy','socks_proxy','ws_proxy','wss_proxy','ws_socks_proxy'])client[name]=undefined;
    const socks=this.restClient.socksProxy,https=this.restClient.httpsProxy,http=this.restClient.httpProxy;
    if(socks){client.socksProxy=socks;client.wsSocksProxy=socks;}
    else if(https||http){
      // All five endpoints use wss://. CCXT maps wssProxy to HttpsProxyAgent (HTTP CONNECT),
      // even when the proxy URL itself is http://; wsProxy maps to the plain HTTP agent.
      client.httpsProxy=https??http;client.wssProxy=https??http;
    }
    // Binance's stream initialization reads its native REST depth snapshot on this
    // separate public client. Bound its response body too, using the REST client's
    // already selected route rather than rereading a possibly changed environment.
    if(!this.injectedWsClient)configureExchangeTransport(client,this.id,{proxyUrl:socks??https??http});
    if(typeof this.restClient.hostname==='string')client.hostname=this.restClient.hostname;
    observeWsSendRejections(client,{isCurrent:()=>!this.closed&&this.client===client,
      onFailure:()=>this.restart('NETWORK_ERROR')});
    return client;
  }

  private shareMarkets():boolean{
    if(!this.restClient.markets||Object.keys(this.restClient.markets).length===0)return false;
    if(typeof this.client.setMarketsFromExchange==='function')this.client.setMarketsFromExchange(this.restClient);
    else{
      for(const name of ['markets','markets_by_id','symbols','ids','currencies','currencies_by_id','baseCurrencies','quoteCurrencies','codes'])this.client[name]=this.restClient[name];
    }
    return true;
  }

  setSymbols(symbols:string[]):void{
    if(this.closed)return;
    const next=new Set<string>();
    for(const symbol of symbols){
      if(next.size>=MAX_REALTIME_PUBLIC_SYMBOLS)break;
      if(typeof symbol==='string'&&isEligibleMarket(this.restClient.markets?.[symbol]))next.add(symbol);
    }
    this.desired=next;
    for(const [symbol,subscription] of this.subscriptions){
      if(!next.has(symbol)){
        subscription.active=false;this.subscriptions.delete(symbol);this.books.delete(symbol);
        const retiring=this.retire(symbol,this.client);
        this.retiring.set(symbol,retiring);
        void retiring.finally(()=>{
          if(this.retiring.get(symbol)===retiring)this.retiring.delete(symbol);
          if(!this.closed&&!this.restarting&&this.desired.has(symbol))this.start(symbol);
          this.emitStatus();
        });
      }
    }
    if(next.size&&!this.watchdog){
      this.watchdog=setInterval(()=>this.sweep(),WATCHDOG_MS);this.watchdog.unref?.();
    }
    if(!next.size&&this.watchdog){clearInterval(this.watchdog);this.watchdog=undefined;}
    if(!this.restarting){
      for(const symbol of next)if(!this.subscriptions.has(symbol)&&!this.retiring.has(symbol))this.start(symbol);
    }
    this.emitStatus();
  }

  private start(symbol:string):void{
    if(this.closed||this.restarting||!this.desired.has(symbol)||this.subscriptions.has(symbol)||this.retiring.has(symbol))return;
    try{
      if(!this.shareMarkets()){this.problem='MARKETS_NOT_READY';this.emitStatus();return;}
    }catch{this.problem='MARKET_METADATA_INVALID';this.emitStatus();return;}
    const subscription:Subscription={symbol,generation:++this.generation,active:true,startedAt:Date.now()};
    this.subscriptions.set(symbol,subscription);this.problem=undefined;
    void this.watch(subscription,this.client);
  }

  private current(subscription:Subscription,client:any):boolean{
    return !this.closed&&subscription.active&&client===this.client&&this.subscriptions.get(subscription.symbol)===subscription&&this.desired.has(subscription.symbol);
  }

  private async watch(subscription:Subscription,client:any):Promise<void>{
    try{
      // setMarketsFromExchange skips loadMarkets, so it also skips that method's proxy module loader.
      if(this.usingProxy&&typeof client.loadProxyModules==='function')await client.loadProxyModules();
      while(this.current(subscription,client)){
        const raw=await client.watchOrderBook(subscription.symbol,DEPTH[this.id],this.watchParams());
        if(!this.current(subscription,client))return;
        this.accept(subscription,raw);
      }
    }catch(error){
      if(this.current(subscription,client))this.restart(streamError(error,this.usingProxy));
    }
  }

  private watchParams():Record<string,unknown>{
    // This is a public V2 perpetual feed, independent of the trading account. CCXT REST calls can
    // auto-detect UTA and mutate rest.options.uta while this loop runs; reading that live flag
    // would move an existing books15 subscription to a different endpoint/channel mid-stream.
    return this.id==='bitget'?{uta:false}:{};
  }

  private accept(subscription:Subscription,raw:any):void{
    const now=Date.now();
    try{
      if(raw?.symbol!==subscription.symbol)throw new Error('BOOK_SYMBOL_MISMATCH');
      const market=this.restClient.markets?.[subscription.symbol],multiplier=Number(market?.contractSize);
      if(!isEligibleMarket(market)||!Number.isFinite(multiplier)||multiplier<=0)throw new Error('MARKET_METADATA_INVALID');
      const eventAt=raw.timestamp===undefined||raw.timestamp===null?undefined:Number(raw.timestamp);
      if(eventAt!==undefined&&(!Number.isFinite(eventAt)||eventAt<=0||eventAt>now+3000||now-eventAt>REALTIME_PUBLIC_BOOK_TTL_MS))throw new Error('STALE_EVENT');
      const nonce=sequence(raw.nonce);
      if(subscription.sequence!==undefined&&nonce!==undefined){
        if(nonce<subscription.sequence){this.restart('OUT_OF_ORDER');return;}
        if(nonce===subscription.sequence)return;
      }
      if(eventAt!==undefined&&subscription.eventAt!==undefined){
        if(eventAt<subscription.eventAt){this.restart('OUT_OF_ORDER');return;}
        if(nonce===undefined&&eventAt===subscription.eventAt)return;
      }
      const bids=levels(raw.bids,multiplier,'bids'),asks=levels(raw.asks,multiplier,'asks');
      if(bids[0].price>=asks[0].price)throw new Error('CROSSED_BOOK');
      const fingerprint=JSON.stringify([bids,asks]);
      // Timestamp/sequence-free replays cannot make a stale cached observation fresh again.
      if(nonce===undefined&&eventAt===undefined&&fingerprint===subscription.fingerprint)return;
      const book:RealtimeBook={exchange:this.id,symbol:subscription.symbol,bids,asks,receivedAt:now,
        ...(eventAt===undefined?{}:{eventAt}),generation:subscription.generation,
        ...(nonce===undefined?{}:{sequence:nonce<=BigInt(Number.MAX_SAFE_INTEGER)?Number(nonce):nonce.toString()})};
      // Missing metadata in one update cannot erase an already established ordering watermark.
      if(nonce!==undefined)subscription.sequence=nonce;
      if(eventAt!==undefined)subscription.eventAt=eventAt;
      subscription.lastReceivedAt=now;subscription.fingerprint=fingerprint;subscription.error=undefined;
      this.books.set(subscription.symbol,book);this.lastEventAt=now;this.problem=undefined;this.consecutiveFailures=0;
      try{this.callbacks.onBook(copyBook(book));}catch{/* consumers cannot interrupt source sequencing */}
      this.emitStatus();
    }catch(error){
      this.books.delete(subscription.symbol);
      // Fixed internal validation codes only. Raw exchange/proxy errors never reach the UI.
      subscription.error=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_BOOK';
      this.emitStatus();
    }
  }

  private async retire(symbol:string,client:any):Promise<void>{
    try{
      // Bitget implements this method without advertising has.unWatchOrderBook in this CCXT build.
      if(typeof client.unWatchOrderBook!=='function')throw new Error('UNWATCH_UNSUPPORTED');
      await bounded(Promise.resolve(client.unWatchOrderBook(symbol,{...this.watchParams(),limit:DEPTH[this.id]})),UNSUBSCRIBE_TIMEOUT_MS);
    }catch{
      if(!this.closed&&client===this.client)this.restart('UNSUBSCRIBE_FAILED');
    }
  }

  private restart(error:string):void{
    if(this.closed||this.restarting)return;
    this.problem=error;this.reconnects++;this.consecutiveFailures++;
    for(const subscription of this.subscriptions.values())subscription.active=false;
    this.subscriptions.clear();this.books.clear();this.retiring.clear();
    const oldClient=this.client;
    const delay=Math.min(5000,250*2**Math.min(this.consecutiveFailures-1,5));
    this.restarting=(async()=>{
      try{await bounded(Promise.resolve(oldClient.close()),UNSUBSCRIBE_TIMEOUT_MS);}catch{/* invalidated generations stay unusable */}
      if(this.closed)return;
      await new Promise<void>(resolve=>{
        this.cancelRetry=resolve;this.retryTimer=setTimeout(resolve,delay);
      });
      this.cancelRetry=undefined;this.retryTimer=undefined;
      if(this.closed)return;
      // Fresh native caches. Late resolutions from the disposed client fail current().
      if(this.injectedWsClient)this.injectedWsClient.orderbooks={};
      this.client=this.makeClient();
    })().catch(()=>{this.problem='PUBLIC_STREAM_INIT_FAILED';}).finally(()=>{
      this.restarting=undefined;
      if(!this.closed)for(const symbol of this.desired)this.start(symbol);
      this.emitStatus();
    });
    this.emitStatus();
  }

  private sweep():void{
    if(this.closed)return;
    const now=Date.now();
    for(const [symbol,book] of this.books){
      if(now-book.receivedAt>REALTIME_PUBLIC_BOOK_TTL_MS){
        this.books.delete(symbol);const subscription=this.subscriptions.get(symbol);if(subscription)subscription.error='STALE_BOOK';
      }
    }
    // A quiet instrument (or a subscription still in CCXT's rate-limited startup queue) is not
    // evidence that the shared socket disconnected. Its quote alone expires. CCXT's transport
    // connection deadline and ping/pong failure reject watch(), which performs generation-wide
    // invalidation in restart(). Never reconnect all 24 instruments because one has no changes.
    this.emitStatus();
  }

  getBook(symbol:string):RealtimeBook|undefined{
    const book=this.books.get(symbol);
    if(!book||this.closed||!this.desired.has(symbol))return undefined;
    if(Date.now()-book.receivedAt>REALTIME_PUBLIC_BOOK_TTL_MS){
      this.books.delete(symbol);const subscription=this.subscriptions.get(symbol);if(subscription)subscription.error='STALE_BOOK';
      this.emitStatus();return undefined;
    }
    return copyBook(book);
  }

  status():RealtimeStreamStatus{
    const fresh=[...this.books.values()].filter(book=>Date.now()-book.receivedAt<=REALTIME_PUBLIC_BOOK_TTL_MS).length;
    const error=this.problem??[...this.subscriptions.values()].find(subscription=>subscription.error)?.error;
    const state:RealtimeStreamStatus['state']=this.closed||!this.desired.size?'disabled':
      this.restarting?'offline':fresh===this.desired.size?'online':fresh?'degraded':this.problem?'offline':
      this.lastEventAt||error?'degraded':'connecting';
    return {exchange:this.id,kind:'public',state,subscriptions:this.desired.size,freshBooks:fresh,lastEventAt:this.lastEventAt,reconnects:this.reconnects,...(error?{error}:{})};
  }

  private emitStatus():void{
    const status=this.status(),key=JSON.stringify(status);
    if(key===this.statusKey)return;
    this.statusKey=key;try{this.callbacks.onStatus?.(status);}catch{/* isolate dashboard callbacks */}
  }

  close():Promise<void>{
    if(this.closePromise)return this.closePromise;
    this.closed=true;
    for(const subscription of this.subscriptions.values())subscription.active=false;
    this.subscriptions.clear();this.desired.clear();this.books.clear();this.retiring.clear();
    if(this.watchdog)clearInterval(this.watchdog);this.watchdog=undefined;
    if(this.retryTimer)clearTimeout(this.retryTimer);this.retryTimer=undefined;
    this.cancelRetry?.();this.cancelRetry=undefined;
    this.emitStatus();
    this.closePromise=(async()=>{
      try{await bounded(Promise.resolve(this.client.close()),UNSUBSCRIBE_TIMEOUT_MS);}catch{/* cache already invalidated */}
      if(this.restarting)await this.restarting;
    })();
    return this.closePromise;
  }
}
