import { positionMetrics, positionTimestamps } from './position-metrics.js';
import ccxt from 'ccxt';
import type { AccountOpenOrder, AccountOverview, AccountPosition, AccountState, AppConfig, ExchangeAdapter, ExchangeId, ExchangeReadContext, FundingPayment, MakerReductionObservation, MarketSnapshot, OrderConfirmationDiagnostic, OrderRequest, OrderResult, PrivateReadContext, TradingFeeMetadata, TradingFeeReference } from '../shared/types.js';
import { amountStep, bitgetMarket, exchangeClientId, fundingClock, isEligibleMarket, marketOrderUnits, milliseconds, normalizeBook, number, unknownOrder } from './normalization.js';
import {isQuantityOnStep,multiplyQuantity,quantityGrid} from '../core/order-quantity.js';
import { readFundingLedger } from './funding-ledger.js';
import { assertExchangeRequestActive, configureExchangeTransport, exchangeApiCode, getExchangeNetworkStatus, withExchangeRequestContext, withoutExchangeRequestContext } from './network.js';
import {configureMarketLoadRecovery} from './ccxt-market-loader.js';
import {configureExchangeClock} from './exchange-clock.js';
import { bitgetAccount, clearBitgetAccountCache, readVerifiedBitgetSettings } from './bitget-account.js';
import { GatePrivate } from './gate-private.js';
import { BybitPrivate } from './bybit-private.js';
import {assertBybitEntryEligibility} from './bybit-entry-eligibility.js';
import {safeExchangeApiMessage} from '../shared/exchange-api-diagnostic.js';
import {readBinanceOpenOrders} from './binance-open-orders.js';
import { BybitPositionCash } from './bybit-position-cash.js';
import { NativeTradingFees } from './native-trading-fees.js';
import {accountFeeIdentity,localAccountFeeCache,LocalAccountFeeCache} from './local-account-fee-cache.js';
import { settleNativeMakerOrder } from './maker-order-lifecycle.js';
import {assertMakerReductionRequest,unknownMakerReduction} from './maker-reduction-observation.js';
import {isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';
import { OrderNotSubmittedError, rejectedOrder } from './order-rejection.js';
import {assertOrderSubmissionPermission} from './order-submission-permission.js';
import { isFeeOnly } from '../shared/strategy-profile.js';
import { REALTIME_PUBLIC_BOOK_TTL_MS, RealtimePublicBooks } from './realtime-public.js';
import { RealtimeOrderEvents, type RealtimeOrderIdentity } from './realtime-orders.js';
import type { RealtimeBook, RealtimeStreamStatus } from '../shared/realtime.js';

interface NativeMakerAccount {
  place:(request:OrderRequest,quantity:number,price:number,canSubmit?:()=>boolean)=>Promise<string|undefined>;
  inspectOrder:(request:OrderRequest,prior:OrderResult,orderId:string)=>Promise<OrderResult>;
  cancel:(symbol:string,orderId:string)=>Promise<void>;
}
interface NativeMakerReductionAccount {
  placeMakerReduction:(request:OrderRequest,quantity:number,price:number,canSubmit?:()=>boolean)=>Promise<string|undefined>;
  inspectMakerReduction:(request:OrderRequest,prior:OrderResult,orderId?:string)=>Promise<MakerReductionObservation>;
  cancel:(symbol:string,orderId:string)=>Promise<void>;
}
interface NativeStreamAccount {submissionIdentity:(request:OrderRequest)=>RealtimeOrderIdentity|undefined}
const MAX_PRIVATE_SUBMISSIONS=512;

interface FeeReferenceOptions {feeReferenceCache?:LocalAccountFeeCache;feeReferencePath?:string}
function confirmation(exchange:ExchangeId,stage:OrderConfirmationDiagnostic['stage'],reason:OrderConfirmationDiagnostic['reason'],error?:unknown):OrderConfirmationDiagnostic {
  const apiCode=exchangeApiCode(exchange,error),apiMessage=safeExchangeApiMessage(exchange,error);return {stage,reason,...(apiCode?{apiCode}:{}),...(apiMessage?{apiMessage}:{})};
}

/** OKX separates ordinary orders from each untriggered algo type. All pages are
 * needed before an empty result can establish absence; these are signed GETs only.
 * https://www.okx.com/docs-v5/en/#order-book-trading-trade-get-order-list
 * https://www.okx.com/docs-v5/en/#order-book-trading-algo-trading-get-algo-order-list */
async function readOkxOpenOrders(client:any,market:any):Promise<AccountOpenOrder[]> {
  if(typeof client.privateGetTradeOrdersPending!=='function'||typeof client.privateGetTradeOrdersAlgoPending!=='function')
    throw new Error('okx: complete native active order observation unavailable');
  const numeric=(value:unknown)=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
  const identity=(value:unknown):string|undefined=>typeof value==='string'&&/^[1-9]\d*$/.test(value)?value:
    typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):undefined;
  const size=numeric(market.contractSize),seen=new Map<string,string>();
  if(!(Number.isFinite(size)&&size>0))throw new Error('okx: contract quantity conversion unavailable');
  const read=async(ordType?:string):Promise<AccountOpenOrder[]>=>{
    const all:AccountOpenOrder[]=[],conditional=ordType!==undefined;let cursor:string|undefined;
    for(let page=0;;page++){
      assertExchangeRequestActive(client,'okx');
      if(page>=200)throw new Error('okx: active order pagination limit reached');
      const params={instId:market.id,limit:'100',...(ordType?{ordType}:{instType:'SWAP'}),...(cursor?{after:cursor}:{})};
      const response=await (conditional?client.privateGetTradeOrdersAlgoPending(params):client.privateGetTradeOrdersPending(params));
      assertExchangeRequestActive(client,'okx');
      if(response?.code!=='0'||!Array.isArray(response.data)||response.data.length>100)
        throw new Error('okx: malformed native active order array');
      for(const raw of response.data){
        const id=identity(conditional?raw?.algoId:raw?.ordId),closeFraction=numeric(raw?.closeFraction),
          fraction=conditional&&!(numeric(raw?.sz)>0)&&closeFraction>0&&closeFraction<=1&&raw?.reduceOnly==='true'&&raw?.posSide==='net',
          q=fraction?0:numeric(raw?.sz),filled=conditional?0:numeric(raw?.accFillSz);
        if(!id||raw?.instId!==market.id||raw?.instType!==undefined&&raw.instType!=='SWAP'||
          !['buy','sell'].includes(raw?.side)||!Number.isFinite(q)||q<0||q===0&&!fraction||!Number.isFinite(filled)||filled<0||filled>q||
          !(conditional?['live','pause']:['live','partially_filled']).includes(raw?.state)||
          conditional&&raw?.ordType!==ordType||raw?.reduceOnly!==undefined&&!['true','false'].includes(raw.reduceOnly)||
          raw?.posSide!==undefined&&!['net','long','short'].includes(raw.posSide)||
          raw?.tdMode!==undefined&&!['cross','isolated'].includes(raw.tdMode))
          throw new Error('okx: native active order identity or quantity is incomplete');
        const nativeClient=conditional?raw.algoClOrdId||raw.clOrdId:raw.clOrdId;
        if(nativeClient!==undefined&&typeof nativeClient!=='string')throw new Error('okx: invalid active client order identity');
        const quantity=q*size,remainingQuantity=(q-filled)*size;
        if(!Number.isFinite(quantity)||!Number.isFinite(remainingQuantity))throw new Error('okx: native active order quantity is invalid');
        const row:AccountOpenOrder={id,...(nativeClient?{clientOrderId:nativeClient}:{}),base:market.base,symbol:market.symbol,
          side:raw.side,quantity,remainingQuantity,...(raw.reduceOnly===undefined?{}:{reduceOnly:raw.reduceOnly==='true'}),kind:conditional?'conditional':'regular'};
        const key=`${row.kind}:${id}`,signature=JSON.stringify([row,raw.posSide,raw.tdMode,ordType]),prior=seen.get(key);
        if(prior!==undefined){if(prior!==signature)throw new Error('okx: conflicting duplicate active order');continue;}
        seen.set(key,signature);all.push(row);
      }
      if(response.data.length<100)return all;
      const next=identity(conditional?response.data.at(-1)?.algoId:response.data.at(-1)?.ordId);
      if(!next||cursor&&BigInt(next)>=BigInt(cursor))throw new Error('okx: active order pagination did not advance');
      cursor=next;
    }
  };
  const groups=await Promise.allSettled([read(),...['conditional','oco','trigger','move_order_stop'].map(type=>read(type))]);
  for(const group of groups)if(group.status==='rejected')throw group.reason;
  return groups.flatMap(group=>(group as PromiseFulfilledResult<AccountOpenOrder[]>).value);
}

/** Bybit's native market classification, never inferred from a coin name. */
export function bybitFeeProfile(market:any):'standard'|'innovation'|'pre-market'|'unknown' {
  if(market.info?.isPreListing===true||market.info?.status==='PreLaunch')return 'pre-market';
  if(market.info?.symbolType==='innovation')return 'innovation';
  if(market.info?.isPreListing===false&&market.info?.symbolType==='')return 'standard';
  return 'unknown';
}

/** Venue quirks live here; all quantities crossing this boundary are BASE COINS, never contracts. */
export class CcxtAdapter implements ExchangeAdapter {
  /** Only Bybit currently has a complete independent native opening-cash proof. */
  verifyOpeningExecution?:ExchangeAdapter['verifyOpeningExecution'];
  readonly client:any;
  private history = new Map<string,{at:number;rows:any[]}>();
  private submitted = new Map<string,{request:string;result:OrderResult}>();
  private okxSubmittedMargins=new Map<string,'cross'|'isolated'>();
  private nativeStreamAccounts=new Map<string,NativeStreamAccount>();
  private makerPending = new Map<string,Promise<OrderResult>>();
  private makerReductions = new Map<string,{request:string;result:OrderResult}>();
  private prepared = new Set<string>();
  private preparedSettings = new Map<string,{leverage:number;marginMode:string}>();
  private diagnostics:{symbol:string;code:string;message:string}[]=[];
  private historyQueue:string[]=[];
  private historyPending=new Set<string>();
  private historyErrors=new Set<string>();
  private historyRunning=0;
  private closed=false;
  private portfolioCash?:BybitPositionCash;
  private tradingFees?:NativeTradingFees;
  private readonly feeReferences:LocalAccountFeeCache;
  private readonly feeIdentity?:string;
  private fundingIntervals?:{at:number;values:Map<string,number>};
  private optionalOi=new Map<string,{attemptedAt:number;at?:number;data?:any;pending:boolean}>();
  private realtimePublish?: (snapshot:MarketSnapshot)=>void;
  private realtimeBases:string[]=[];
  private publicBooks?:RealtimePublicBooks;
  private privateEvents?:RealtimeOrderEvents;
  private realtimeStarting=false;
  private readonly realtimeSeeds=new Map<string,MarketSnapshot>();

  private privateStreamError=false;
  private privateRealtimeStarting=false;
  private privateRealtimeAttemptAt=0;
  constructor(public readonly id:ExchangeId, private config:AppConfig, injectedClient?:any,private readonly publicMonitoringOnly=false,feeReferenceOptions:FeeReferenceOptions={}) {
    const name = id === 'binance' ? 'binanceusdm' : id;
    const Constructor = (ccxt as any)[name];
    const prefix = id.toUpperCase();
    this.client = injectedClient ?? new Constructor({
      enableRateLimit:true,timeout:12000,has:{fetchCurrencies:false},
      apiKey:config.mode==='live'?process.env[`${prefix}_API_KEY`]:undefined,secret:config.mode==='live'?process.env[`${prefix}_API_SECRET`]:undefined,
      password:config.mode==='live'&&['okx','bitget'].includes(id) ? process.env[`${prefix}_PASSPHRASE`] : undefined,
      options:{defaultType:'swap',defaultSubType:'linear',defaultSettle:'USDT',adjustForTimeDifference:config.mode==='live',
        fetchMarkets:{types:['binance','bybit'].includes(id)?['linear']:['swap']},
        ...(id === 'gate' ? {unifiedAccount:false,swap:{fetchMarkets:{settlementCurrencies:['usdt']}}} : {})},
    });
    // Injected/offline clients use an isolated memory store unless a test explicitly supplies a path/store.
    this.feeReferences=feeReferenceOptions.feeReferenceCache??(feeReferenceOptions.feeReferencePath
      ?localAccountFeeCache(feeReferenceOptions.feeReferencePath):injectedClient?new LocalAccountFeeCache():localAccountFeeCache());
    this.feeIdentity=accountFeeIdentity(this.client);
    if(!injectedClient){configureExchangeTransport(this.client,id);configureExchangeClock(this.client,id);}
    configureMarketLoadRecovery(this.client);
    if(id==='bybit')this.verifyOpeningExecution=this.verifyBybitOpeningExecution.bind(this);
    if(!injectedClient && id==='bitget') {
      // The generic CCXT loader requests six contract categories. This product only uses USDT perpetuals.
      this.client.fetchMarkets=async()=>{
        const response=await this.client.publicMixGetV2MixMarketContracts({productType:'USDT-FUTURES'});
        if(!Array.isArray(response.data))throw new Error('bitget: invalid contract metadata response');
        return response.data.map(bitgetMarket).filter(Boolean);
      };
    }
  }
  getDiagnostics(){return this.diagnostics.map(x=>({...x}));}
  getNetworkStatus(){return getExchangeNetworkStatus(this.client);}
  startRealtime(publish:(snapshot:MarketSnapshot)=>void):void {
    if(this.publicMonitoringOnly||this.config.dataSource!=='public'||process.env.FUNDING_WS_ENABLED==='0'||this.closed)return;
    this.realtimePublish=publish;
    if(this.publicBooks||this.realtimeStarting)return;
    this.realtimeStarting=true;
    void this.client.loadMarkets().then(()=>{
      if(this.closed)return;
      this.publicBooks=new RealtimePublicBooks(this.id,this.client,{onBook:book=>{
        if(this.closed)return;const snapshot=this.mergeBook(book);if(snapshot)this.realtimePublish?.(snapshot);
      }});
      this.syncRealtimeSymbols();
      void this.startPrivateRealtime();
    }).catch(()=>{}).finally(()=>{this.realtimeStarting=false;});
  }
  private async startPrivateRealtime():Promise<void> {
      if(this.closed||this.publicMonitoringOnly||!this.realtimePublish||this.privateEvents||this.privateRealtimeStarting||
        Date.now()-this.privateRealtimeAttemptAt<10000||this.config.mode!=='live'||!this.client.apiKey||!this.client.secret||
        (['okx','bitget'].includes(this.id)&&!this.client.password))return;
      this.privateRealtimeStarting=true;this.privateRealtimeAttemptAt=Date.now();
      try {
        let accountMode:'classic'|'unified'|undefined;
        if(this.id==='bitget'){
          // The stream and account poll share this real GET. Give its first creator
          // a read budget; joining later must not leave an unbudgeted native permit.
          const timeout=Number(this.client.timeout),budget=Number.isFinite(timeout)&&timeout>0?Math.min(timeout,8000):8000;
          const {data}=await withExchangeRequestContext(this.client,{deadlineAt:Date.now()+budget},()=>readVerifiedBitgetSettings(this.client));
          accountMode=data.accountMode==='unified'?'unified':'classic';
        }
        if(this.closed)return;
        this.privateEvents=new RealtimeOrderEvents(this.id,this.client,{accountMode});this.privateStreamError=false;this.syncRealtimeSymbols();
      }catch{this.privateStreamError=true;}finally{this.privateRealtimeStarting=false;}
  }
  setRealtimeBases(bases:string[]):void {this.realtimeBases=[...new Set(bases)].slice(0,24);this.syncRealtimeSymbols();}
  private syncRealtimeSymbols():void {
    if(!this.client.markets)return;
    const symbols=this.realtimeBases.map(base=>Object.values(this.client.markets).find((m:any)=>isEligibleMarket(m)&&m.base===base))
      .filter(Boolean).map((m:any)=>m.symbol);
    this.publicBooks?.setSymbols(symbols);this.privateEvents?.setSymbols(symbols);
  }
  seedRealtimeSnapshot(snapshot:MarketSnapshot):void {
    if(snapshot.bookTransport==='websocket')return;
    this.rememberRealtimeSeed(snapshot);
  }
  private rememberRealtimeSeed(snapshot:MarketSnapshot):void {
    if(this.closed||snapshot.exchange!==this.id||snapshot.source!=='public')return;
    const prior=this.realtimeSeeds.get(snapshot.base),observed=snapshot.fundingObservedAt??snapshot.observedAt??snapshot.timestamp;
    if(prior&&(prior.fundingObservedAt??prior.observedAt??prior.timestamp)>observed)return;
    this.realtimeSeeds.set(snapshot.base,{...snapshot,fundingObservedAt:observed});
  }
  private mergeBook(book:RealtimeBook):MarketSnapshot|undefined {
    const seed=[...this.realtimeSeeds.values()].find(snapshot=>snapshot.symbol===book.symbol),now=Date.now();
    if(!seed||!Number.isFinite(seed.fundingObservedAt)||seed.fundingObservedAt!<=0||seed.fundingObservedAt!>now+5000||now-seed.fundingObservedAt!>Math.min(this.config.maxSnapshotAgeMs,30000)||
      now-book.receivedAt>2000||book.receivedAt>now+5000)return;
    const fee=this.cachedTradingFee(seed.symbol);
    // A fresh book is not new account-fee evidence. A Taker-only refresh (or no cache)
    // must remove earlier optional Maker metadata carried by the funding seed.
    return {...seed,bids:book.bids,asks:book.asks,observedAt:book.receivedAt,timestamp:book.eventAt??book.receivedAt,
      bookTransport:'websocket',bookGeneration:book.generation,...fee,
      feeReference:this.referenceTradingFee(seed.symbol),
      makerFeeRate:fee?.makerFeeRate,makerFeeAt:fee?.makerFeeAt,makerFeeSource:fee?.makerFeeSource};
  }
  getExecutionSnapshot(base:string):MarketSnapshot|undefined {
    const seed=this.realtimeSeeds.get(base);if(!seed)return;
    const book=this.freshPublicBook(seed.symbol);return book?this.mergeBook(book):undefined;
  }
  private freshPublicBook(symbol:string):RealtimeBook|undefined {
    let book:RealtimeBook|undefined;
    try{book=this.publicBooks?.getBook(symbol);}catch{return;}
    const now=Date.now();
    if(!book||book.exchange!==this.id||book.symbol!==symbol||!Number.isSafeInteger(book.generation)||book.generation<=0||
      !Number.isFinite(book.receivedAt)||book.receivedAt<=0||book.receivedAt>now||now-book.receivedAt>REALTIME_PUBLIC_BOOK_TTL_MS||
      book.eventAt!==undefined&&(!Number.isFinite(book.eventAt)||book.eventAt<=0||book.eventAt>now+3000||now-book.eventAt>REALTIME_PUBLIC_BOOK_TTL_MS))return;
    for(const side of ['bids','asks'] as const){
      const levels=book[side];if(!Array.isArray(levels)||!levels.length)return;
      for(let i=0;i<levels.length;i++){
        const level=levels[i];if(!level||!Number.isFinite(level.price)||level.price<=0||!Number.isFinite(level.quantity)||level.quantity<=0||
          i>0&&(side==='bids'?level.price>=levels[i-1].price:level.price<=levels[i-1].price))return;
      }
    }
    return book.bids[0].price<book.asks[0].price?book:undefined;
  }
  async fetchExecutionSnapshots(bases:string[],context?:PrivateReadContext):Promise<MarketSnapshot[]> {
    return withExchangeRequestContext(this.client,context??{},async()=>{
      assertExchangeRequestActive(this.client,this.id);
      const snapshots=await this.fetchExecutionSnapshotBatch(bases);
      assertExchangeRequestActive(this.client,this.id);
      return snapshots;
    });
  }
  private async fetchExecutionSnapshotBatch(bases:string[]):Promise<MarketSnapshot[]> {
    await this.client.loadMarkets();
    assertExchangeRequestActive(this.client,this.id);
    const reads=await Promise.allSettled(bases.map(async base=>{
      assertExchangeRequestActive(this.client,this.id);
      const pushed=this.getExecutionSnapshot(base);if(pushed)return pushed;
      const seed=this.realtimeSeeds.get(base),now=Date.now();
      if(!seed||now-(seed.fundingObservedAt??seed.observedAt??seed.timestamp)>Math.min(this.config.maxSnapshotAgeMs,30000)){
        const rows=await this.fetchSnapshots([base]);return rows[0];
      }
      // Only the order book is refreshed here. Funding/index/mark retain their own observation time.
      const m=this.market(seed.symbol),book=await this.client.fetchOrderBook(seed.symbol,50),receivedAt=Date.now();
      assertExchangeRequestActive(this.client,this.id);
      const bids=normalizeBook(book.bids,number(m.contractSize)),asks=normalizeBook(book.asks,number(m.contractSize));
      if(!bids.length||!asks.length||bids[0].price>asks[0].price)throw new Error('Empty/crossed execution book');
      const fee=this.cachedTradingFee(seed.symbol);
      return {...seed,bids,asks,observedAt:receivedAt,timestamp:receivedAt,bookTransport:'rest' as const,...fee,
        feeReference:this.referenceTradingFee(seed.symbol),
        makerFeeRate:fee?.makerFeeRate,makerFeeAt:fee?.makerFeeAt,makerFeeSource:fee?.makerFeeSource};
    }));
    for(const read of reads)if(read.status==='rejected')throw read.reason;
    assertExchangeRequestActive(this.client,this.id);
    return reads.map(read=>(read as PromiseFulfilledResult<MarketSnapshot>).value);
  }


  realtimeStatus():RealtimeStreamStatus[]{return [this.publicBooks?.status()??{exchange:this.id,kind:'public' as const,state:this.realtimeStarting?'connecting' as const:'disabled' as const,subscriptions:0,lastEventAt:0,reconnects:0},
    this.privateEvents?.status()??{exchange:this.id,kind:'private' as const,state:this.privateStreamError?'degraded' as const:'disabled' as const,subscriptions:0,lastEventAt:0,reconnects:0}];}
  private assertLive() {
    if (this.config.mode !== 'live' || this.config.dataSource !== 'public') throw new Error('Private trading API is disabled in paper/demo mode');
    if (!this.client.apiKey || !this.client.secret || (['okx','bitget'].includes(this.id) && !this.client.password))
      throw new Error(`${this.id}: API credentials are missing from environment`);
  }
  private market(symbol:string):any {
    const m = this.client.market(symbol);
    if (!isEligibleMarket(m)) throw new Error(`${this.id}: only active linear USDT perpetuals are supported: ${symbol}`);
    return m;
  }
  private async historicalRates(symbol:string):Promise<any[]> {
    const cached = this.history.get(symbol);
    if (cached && Date.now()-cached.at < 300000) return cached.rows;
    const rows = (await this.client.fetchFundingRateHistory(symbol,undefined,8))
      .filter((r:any)=>Number.isFinite(number(r.fundingRate))).sort((a:any,b:any)=>number(a.timestamp)-number(b.timestamp));
    if (rows.length < 2) throw new Error(`${this.id}: insufficient settled funding history for ${symbol}`);
    this.history.set(symbol,{at:Date.now(),rows}); return rows;
  }
  private warmHistory(symbol:string){
    const cached=this.history.get(symbol);
    if(this.closed || this.historyPending.has(symbol) || (cached && Date.now()-cached.at<300000))return;
    this.historyPending.add(symbol);this.historyQueue.push(symbol);this.drainHistory();
  }
  private drainHistory(){
    while(!this.closed && this.historyRunning<2 && this.historyQueue.length){
      const symbol=this.historyQueue.shift()!;this.historyRunning++;
      void this.historicalRates(symbol).then(()=>this.historyErrors.delete(symbol),()=>this.historyErrors.add(symbol))
        .finally(()=>{this.historyPending.delete(symbol);this.historyRunning--;this.drainHistory();});
    }
  }
  private async refreshFundingIntervals(){
    if(this.id!=='binance' || typeof this.client.fapiPublicGetFundingInfo!=='function')return;
    if(this.fundingIntervals && Date.now()-this.fundingIntervals.at<60000)return;
    try {
      const rows=await this.client.fapiPublicGetFundingInfo();
      if(!Array.isArray(rows))throw new Error('Invalid funding interval metadata');
      const values=new Map<string,number>();
      for(const r of rows)if(number(r.fundingIntervalHours)>0)values.set(r.symbol,number(r.fundingIntervalHours));
      this.fundingIntervals={at:Date.now(),values};
    }catch{this.diagnostics.push({symbol:'*',code:'FUNDING_INTERVAL_UNAVAILABLE',message:'资金费周期配置暂不可用，将核验最近结算记录'});}
  }
  async fetchSnapshots(bases:string[],context?:ExchangeReadContext):Promise<MarketSnapshot[]> {
    return context?withExchangeRequestContext(this.client,context,()=>this.fetchSnapshotBatch(bases)):this.fetchSnapshotBatch(bases);
  }
  private async fetchSnapshotBatch(bases:string[]):Promise<MarketSnapshot[]> {
    assertExchangeRequestActive(this.client,this.id);
    this.diagnostics=[];
    await this.client.loadMarkets();
    assertExchangeRequestActive(this.client,this.id);
    if(this.realtimePublish)withoutExchangeRequestContext(this.client,()=>{this.startRealtime(this.realtimePublish!);void this.startPrivateRealtime();});
    await this.refreshFundingIntervals();
    assertExchangeRequestActive(this.client,this.id);
    const markets = Object.values(this.client.markets).filter((m:any)=>isEligibleMarket(m) && bases.includes(m.base));
    const snapshots:MarketSnapshot[] = [];
    for(const base of bases)if(!(markets as any[]).some(m=>m.base===base))
      this.diagnostics.push({symbol:base,code:'SYMBOL_UNAVAILABLE',message:'未找到对应的有效 USDT 永续合约'});
    let cursor=0;
    const worker=async()=>{
      while(cursor<markets.length){
        assertExchangeRequestActive(this.client,this.id);
        const market:any=markets[cursor++];
        try {
          const snapshot=await this.snapshot(market);
          assertExchangeRequestActive(this.client,this.id);
          // One slow unrelated symbol must not discard metadata already observed
          // within this batch's budget. Whole-batch publication still waits below.
          this.rememberRealtimeSeed(snapshot);snapshots.push(snapshot);
        }
        catch { assertExchangeRequestActive(this.client,this.id);this.diagnostics.push({symbol:market.base,code:'SYMBOL_FETCH_FAILED',message:'该币种行情请求失败或关键字段不完整'}); }
      }
    };
    // Retain the caller's in-flight ownership until both native workers finish.
    // A deadline in one worker must not release a still-running sibling batch.
    const workers=await Promise.allSettled([worker(),worker()]);
    assertExchangeRequestActive(this.client,this.id);
    const failed=workers.find((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failed)throw failed.reason;
    if (!snapshots.length) throw new Error(`${this.id}: no requested active linear USDT perpetual markets`);
    for(const s of this.publicMonitoringOnly&&isFeeOnly(this.config)?[]:snapshots){
      const cached=this.history.get(s.symbol);
      if(!cached || Date.now()-cached.at>=300000){
        this.diagnostics.push({symbol:s.base,code:this.historyErrors.has(s.symbol)?'HISTORY_UNAVAILABLE':'HISTORY_PENDING',message:'历史资金费率正在补充，当前报价来自实时接口'});
        withoutExchangeRequestContext(this.client,()=>this.warmHistory(s.symbol));
      }
    }
    // This path just fetched fresh funding metadata, even when depth came from WebSocket.
    // External pushed snapshots still cannot renew metadata through seedRealtimeSnapshot().
    for(const snapshot of snapshots)this.rememberRealtimeSeed(snapshot);
    withoutExchangeRequestContext(this.client,()=>this.syncRealtimeSymbols());
    return snapshots.sort((a,b)=>bases.indexOf(a.base)-bases.indexOf(b.base));
  }
  private async snapshot(m:any):Promise<MarketSnapshot> {
    assertExchangeRequestActive(this.client,this.id);
    const started = Date.now();
    // Bybit ticker contains rate, mark/index, OI and next settlement; avoid fetching it twice.
    const tickerRequest=this.client.fetchTicker(m.symbol);
    const fundingRequest=this.id==='bybit'
      ? tickerRequest.then((t:any)=>this.client.parseFundingRate(t.info,m))
      : this.client.fetchFundingRate(m.symbol);
    const initialPublicBook=this.freshPublicBook(m.symbol);
    let bookObservedAt=started;
    const fetchRestBook=()=>{assertExchangeRequestActive(this.client,this.id);return this.client.fetchOrderBook(m.symbol,50).then((book:any)=>{
      // Other data or a funding-clock fallback can finish later. They must not refresh this book's age.
      bookObservedAt=Date.now();return book;
    });};
    // A live public stream already supplies depth for hot/held instruments. Poll funding and
    // ticker independently, then select the latest genuine book observation after those reads.
    // Cold instruments keep their concurrent REST read, so this optimization does not delay scans.
    const bookRequest=initialPublicBook?Promise.resolve(null):fetchRestBook();
    const results = await Promise.allSettled([
      fundingRequest,bookRequest,tickerRequest,
      this.publicMonitoringOnly&&isFeeOnly(this.config)||['gate','bybit','bitget'].includes(this.id) ? Promise.resolve(null) : isFeeOnly(this.config)?Promise.resolve(withoutExchangeRequestContext(this.client,()=>this.optionalOpenInterest(m.symbol))):this.client.fetchOpenInterest(m.symbol),
      this.id === 'okx' ? this.client.publicGetPublicMarkPrice({instType:'SWAP',instId:m.id}) : Promise.resolve(null),
      this.id === 'okx' ? this.client.publicGetMarketIndexTickers({instId:`${m.baseId ?? m.base}-USDT`}) : Promise.resolve(null),
    ]);
    assertExchangeRequestActive(this.client,this.id);
    for (let i=0;i<results.length;i++) if (i!==1&&results[i].status === 'rejected') throw (results[i] as PromiseRejectedResult).reason;
    const [funding,restBook,ticker,oi,okxMark,okxIndex] = results.map(r=>r.status==='fulfilled'?r.value:null);
    let history=this.history.get(m.symbol)?.rows ?? [];
    const markPrice = number(funding.markPrice ?? ticker.markPrice ?? ticker.info?.markPrice ?? okxMark?.data?.[0]?.markPx);
    const indexPrice = number(funding.indexPrice ?? ticker.indexPrice ?? ticker.info?.indexPrice ?? okxIndex?.data?.[0]?.idxPx);
    if (!(markPrice > 0 && indexPrice > 0)) throw new Error('Mark/index price unavailable');
    const contractSize = number(m.contractSize), raw = funding.info ?? {};
    const openInterestUsd = this.id === 'gate'
      ? number(raw.position_size)*contractSize*markPrice
      : this.id==='bitget' ? number(ticker.info?.holdingAmount ?? ticker.info?.openInterest)*markPrice
      : this.id==='bybit' ? number(ticker.info?.openInterestValue,number(ticker.info?.openInterest)*markPrice)
      : number(oi?.openInterestValue,number(oi?.openInterestAmount)* (this.id === 'okx' ? contractSize : 1) *markPrice);
    const volume24hUsd = this.id === 'okx'
      ? number(ticker.info?.volCcy24h,number(ticker.baseVolume)*contractSize)*markPrice
      : number(ticker.quoteVolume,number(ticker.baseVolume)*markPrice);
    if(this.id==='binance' && !funding.interval && this.fundingIntervals && Date.now()-this.fundingIntervals.at<120000){
      // fundingInfo enumerates interval adjustments. A successfully fetched list confirms the 8h default for absent symbols.
      funding.interval=`${this.fundingIntervals.values.get(m.id)??8}h`;
    }
    let clock;
    try{clock=fundingClock(this.id,funding,m,history,Date.now());}
    catch{assertExchangeRequestActive(this.client,this.id);history=await this.historicalRates(m.symbol);assertExchangeRequestActive(this.client,this.id);clock=fundingClock(this.id,funding,m,history,Date.now());}
    // Re-read after all metadata/clock awaits. A stream can disconnect or expire while a
    // ticker request is pending; the earlier fresh book must never be given a new timestamp.
    const publicBook=this.freshPublicBook(m.symbol);
    let book=restBook;
    if(!publicBook&&!book){
      if(results[1].status==='rejected')throw results[1].reason;
      book=await fetchRestBook();
    }
    // Public stream quantities are already base coins. REST depth still contains contracts.
    const bids = publicBook?.bids??normalizeBook(book.bids,contractSize), asks = publicBook?.asks??normalizeBook(book.asks,contractSize);
    if (!bids.length || !asks.length || bids[0].price > asks[0].price) throw new Error('Empty/crossed order book');
    const fundingRate = number(funding.fundingRate);
    if (!Number.isFinite(fundingRate)||!isFeeOnly(this.config)&&![openInterestUsd,volume24hUsd].every(Number.isFinite)) throw new Error('Funding/OI/volume unavailable');
    if(isFeeOnly(this.config)&&!Number.isFinite(openInterestUsd))this.diagnostics.push({symbol:m.base,code:'OI_UNAVAILABLE',message:'持仓量正在后台更新或暂不可用；完整资金费与盘口判断仍可使用'});
    if(isFeeOnly(this.config)&&!Number.isFinite(volume24hUsd))this.diagnostics.push({symbol:m.base,code:'VOLUME_UNAVAILABLE',message:'成交额暂不可用；完整资金费与盘口判断仍可使用'});
    const timestamps = [started,publicBook?.eventAt??publicBook?.receivedAt??book?.timestamp,ticker.timestamp,funding.timestamp,raw.ts,raw.time,okxMark?.data?.[0]?.ts,okxIndex?.data?.[0]?.ts].map(milliseconds)
      .filter(t=>Number.isFinite(t) && t > 0);
    if(timestamps.some(t=>t>Date.now()+5000))throw new Error('Market observation timestamp is ahead of local clock');
    // Deprecated next-period fields are not forecasts for the settlement represented by this snapshot.
    const predictedRate=number(funding.nextFundingRate),predictedTime=milliseconds(funding.nextFundingTimestamp);
    const predictedFundingRate=!['gate','okx'].includes(this.id)&&Number.isFinite(predictedRate)&&predictedTime===clock.nextFundingTime?predictedRate:undefined;
    return {exchange:this.id,base:m.base,symbol:m.symbol,timestamp:Math.min(...timestamps),observedAt:publicBook?.receivedAt??bookObservedAt,markPrice,indexPrice,
      fundingRate,...clock,predictedFundingRate,
      fundingHistory:history.map((r:any)=>number(r.fundingRate)),bids,asks,openInterestUsd,volume24hUsd,
      quantityStep:amountStep(m,this.client.precisionMode),minQuantity:multiplyQuantity(number(m.limits?.amount?.min,0),contractSize),
      minNotional:number(m.limits?.cost?.min,0),contractSize,source:'public',bookTransport:publicBook?'websocket':'rest',
      ...(publicBook?{bookGeneration:publicBook.generation}:{}),fundingObservedAt:started,
      feeReference:this.referenceTradingFee(m.symbol),...(this.id==='bybit'?{feeProfile:bybitFeeProfile(m)}:{})};
  }
  private optionalOpenInterest(symbol:string):any {
    const now=Date.now(),cached=this.optionalOi.get(symbol);
    if(!this.closed&&!cached?.pending&&(!cached||now-cached.attemptedAt>=60000)){
      const next={attemptedAt:now,pending:true} as {attemptedAt:number;at?:number;data?:any;pending:boolean};
      this.optionalOi.set(symbol,next);
      // Optional liquidity data cannot hold up fresh prices. Failed reads also get a one-minute backoff.
      void Promise.resolve().then(()=>this.client.fetchOpenInterest(symbol)).then(data=>{
        if(!this.closed){next.data=data;next.at=Date.now();}
      },()=>{}).finally(()=>{next.pending=false;});
    }
    return cached?.at!==undefined&&now-cached.at<60000?cached.data:null;
  }
  async fetchAccountOverview():Promise<AccountOverview> {
    this.assertLive();
    // Bitget overview only counts returned positions; it does not require market metadata or trading mode approval.
    if(this.id==='bitget')return (await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode)).fetchAccountOverview();
    if(this.id==='gate'){await this.client.loadMarkets();return new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode).fetchAccountOverview();}
    if(this.id==='bybit'){await this.client.loadMarkets();return new BybitPrivate(this.client,this.config.marginMode).fetchAccountOverview();}
    const account=await this.fetchAccount();
    return {freeUsd:account.freeUsd,equityUsd:account.equityUsd,positionCount:account.positions.length,balanceScope:'usdt_futures'};
  }
  async fetchOpenOrders(symbol:string,context?:PrivateReadContext):Promise<AccountOpenOrder[]>{
    return withExchangeRequestContext(this.client,context??{},async()=>{
      assertExchangeRequestActive(this.client,this.id);
      const orders=await this.fetchOpenOrdersRead(symbol);
      assertExchangeRequestActive(this.client,this.id);
      return orders;
    });
  }
  private async fetchOpenOrdersRead(symbol:string):Promise<AccountOpenOrder[]>{
    this.assertLive();await this.client.loadMarkets();assertExchangeRequestActive(this.client,this.id);const market=this.market(symbol);
    if(this.id==='binance')return readBinanceOpenOrders(this.client,market);
    if(this.id==='okx')return readOkxOpenOrders(this.client,market);
    if(this.id==='gate')return new GatePrivate(this.client).fetchOpenOrders(symbol);
    if(this.id==='bybit')return new BybitPrivate(this.client,this.config.marginMode).fetchOpenOrders(symbol);
    if(this.id==='bitget'){
      const account=await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode);
      assertExchangeRequestActive(this.client,this.id);
      if('fetchOpenOrders' in account)return account.fetchOpenOrders(symbol);
    }
    // Account-specific conditional-order endpoints must be implemented before an empty result can prove flatness.
    throw new Error(`${this.id}: complete read-only active order observation is unsupported`);
  }
  async inspectOrder(request:OrderRequest,orderId?:string):Promise<OrderResult>{
    this.assertLive();await this.client.loadMarkets();this.market(request.symbol);
    const prior=this.submitted.get(request.clientOrderId)?.result??unknownOrder(request,orderId);
    if(this.id==='gate')return this.inspectedTerminalRead(request,await new GatePrivate(this.client).inspectOrder(request,prior,orderId));
    if(this.id==='bybit')return new BybitPrivate(this.client,this.config.marginMode).inspectOrder(request,prior,orderId);
    if(this.id==='bitget')return this.inspectedTerminalRead(request,await (await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode)).inspectOrder(request,prior,orderId));
    if(this.id==='binance'||this.id==='okx'){
      const known=this.submitted.get(request.clientOrderId);
      if(known&&known.request!==JSON.stringify(request))throw new Error('Client order ID reused with different order details');
      if(prior.rejectionCode&&prior.status==='cancelled'&&prior.filledQuantity===0&&!prior.id)return prior;
      try{
        const exactId=orderId??(prior.id||undefined),clientId=exchangeClientId(this.id,request.clientOrderId);
        const raw=await this.client.fetchOrder(exactId??clientId,request.symbol,exactId?{}:{clientOrderId:clientId});
        const result=await this.orderResult(raw,request,this.market(request.symbol),exactId);
        if(result.filledQuantity+1e-12<prior.filledQuantity)throw new Error('Regressive cumulative order execution');
        // Observation must not call reconcileOrder: its anomalous-open IOC path cancels orders.
        return this.inspectedTerminalRead(request,result);
      }catch(error){return {...prior,status:'unknown',confirmation:confirmation(this.id,'order-read','request-failed',error)};}
    }
    throw new Error(`${this.id}: read-only order inspection is unsupported`);
  }
  /** Only a complete terminal native GET may add a successful read time; cached and failed paths retain their original evidence. */
  private inspectedTerminalRead(request:OrderRequest,result:OrderResult):OrderResult{
    if(!isTerminalOrderReceipt(request,result)||result.confirmation||!Number.isFinite(result.feeUsd)||result.averagePriceVerified===false||
      result.filledQuantity>0&&!(Number.isFinite(result.averagePrice)&&result.averagePrice>0))return result;
    return {...result,orderReadAt:Date.now()};
  }
  /** Independent GET-only execution valuation; never updates a submitted order or persisted journal. */
  private async verifyBybitOpeningExecution(request:OrderRequest,orderId:string):Promise<OrderResult>{
    this.assertLive();
    if(request.reduceOnly!==false||request.postOnly===true||request.closePosition!==undefined)
      throw new Error('bybit: opening execution proof only supports ordinary opening IOC orders');
    if(typeof orderId!=='string'||!orderId.trim())throw new Error('Opening execution proof requires the original native ID');
    const known=this.submitted.get(request.clientOrderId);
    if(known&&known.request!==JSON.stringify(request))throw new Error('Client order ID reused with different order details');
    const prior=known?.result??unknownOrder(request,orderId);
    if(prior.id&&orderId!==prior.id)throw new Error('Opening execution native ID changed');
    await this.client.loadMarkets();this.market(request.symbol);
    return new BybitPrivate(this.client,this.config.marginMode).verifyOpeningExecution(request,prior,orderId);
  }
  /** Independent reduction valuation retains its original reduce-only permission boundary. */
  async verifyOrderExecution(request:OrderRequest,orderId?:string):Promise<OrderResult>{
    if(this.id==='bybit'){
      this.assertLive();
      if(request.reduceOnly!==true||request.postOnly===true||request.closePosition!==undefined)
        throw new Error('bybit: execution proof only supports ordinary reduce-only IOC orders');
      const known=this.submitted.get(request.clientOrderId);
      if(known&&known.request!==JSON.stringify(request))throw new Error('Client order ID reused with different order details');
      const prior=known?.result??unknownOrder(request,orderId);
      if(orderId&&prior.id&&orderId!==prior.id)throw new Error('Reduction execution native ID changed');
      await this.client.loadMarkets();this.market(request.symbol);
      return new BybitPrivate(this.client,this.config.marginMode).verifyOrderExecution(request,prior,orderId);
    }
    this.assertLive();await this.client.loadMarkets();this.market(request.symbol);
    if(this.id==='bitget'){
      const account=await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode);
      if('verifyOrderExecution' in account)return this.inspectedTerminalRead(request,await account.verifyOrderExecution(request,this.submitted.get(request.clientOrderId)?.result??unknownOrder(request,orderId),orderId));
    }
    throw new Error(`${this.id}: independent execution price verification is unsupported`);
  }
  async fetchClosePositions(symbol:string):Promise<AccountPosition[]>{
    await this.client.loadMarkets();
    if(this.id==='gate')return new GatePrivate(this.client).fetchClosePositions(symbol);
    throw new Error(`${this.id}: native split-position close is unsupported`);
  }
  async fetchPortfolioAccount():Promise<AccountState> {
    if(this.id==='gate'){
      this.assertLive();await this.client.loadMarkets();
      return this.enrichTradingFees(await new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode).fetchPortfolioAccount());
    }
    if(this.id!=='bybit')return this.fetchAccount();
    this.assertLive();await this.client.loadMarkets();
    this.portfolioCash??=new BybitPositionCash(params=>this.client.privateGetV5AccountTransactionLog(params));
    return this.enrichTradingFees(await new BybitPrivate(this.client,this.config.marginMode).fetchAccount(this.portfolioCash));
  }
  async fetchAccount(context?:PrivateReadContext):Promise<AccountState> {
    return withExchangeRequestContext(this.client,context??{},async()=>{
      assertExchangeRequestActive(this.client,this.id);
      const account=await this.fetchAccountRaw();
      assertExchangeRequestActive(this.client,this.id);
      return this.enrichTradingFees(account);
    });
  }
  private feesEnabled():boolean {
    return !this.closed&&!this.publicMonitoringOnly&&this.config.mode==='live'&&this.config.dataSource==='public'&&
      !!this.client.apiKey&&!!this.client.secret&&(!['okx','bitget'].includes(this.id)||!!this.client.password);
  }
  private nativeFees():NativeTradingFees {
    return this.tradingFees??=new NativeTradingFees(this.id,this.client,symbol=>this.market(symbol),Date.now,6000,{
      reference:symbol=>this.referenceTradingFee(symbol),
      onObservation:(symbol,fee)=>this.feeReferences.remember(this.id,this.feeIdentity,symbol,{
        source:'account-reference',takerRate:fee.takerFeeRate,observedAt:fee.takerFeeAt,
        ...(fee.makerFeeRate===undefined?{}:{makerRate:fee.makerFeeRate})}),
    });
  }
  private enrichTradingFees(account:AccountState):AccountState {
    return this.feesEnabled()?{...account,positions:this.nativeFees().enrich(account.positions)}:account;
  }
  cachedTradingFee(symbol:string):TradingFeeMetadata|undefined {
    return this.feesEnabled()?this.tradingFees?.cached(symbol):undefined;
  }
  referenceTradingFee(symbol:string):TradingFeeReference|undefined {
    if(!this.feesEnabled())return;
    try{return this.feeReferences.cached(this.id,this.feeIdentity,symbol);}catch{return;}
  }
  async fetchTradingFee(symbol:string):Promise<TradingFeeMetadata|undefined> {
    if(!this.feesEnabled())return;
    try{await this.client.loadMarkets();this.market(symbol);return this.nativeFees().fetch(symbol);}
    catch{return undefined;}
  }


  private async fetchAccountRaw():Promise<AccountState> {
    this.assertLive(); await this.client.loadMarkets();
    assertExchangeRequestActive(this.client,this.id);
    if(this.id==='bitget'){
      const account=await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode);
      assertExchangeRequestActive(this.client,this.id);
      return account.fetchAccount();
    }
    if(this.id==='gate')return new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode).fetchAccount();
    if(this.id==='bybit')return new BybitPrivate(this.client,this.config.marginMode).fetchAccount();
    const result = await Promise.allSettled([
      this.client.fetchBalance(this.id==='binance'||this.id==='okx'?{type:'swap'}:{type:'swap',settle:'USDT'}),
      this.client.fetchPositions(undefined,this.positionQuery()),
    ]);
    for (const r of result) if (r.status === 'rejected') throw r.reason;
    const [balance,positions] = result.map(r=>(r as PromiseFulfilledResult<any>).value);
    const freeUsd = number(balance.USDT?.free ?? balance.free?.USDT);
    const equityUsd = number(balance.USDT?.total ?? balance.total?.USDT);
    if (![freeUsd,equityUsd].every(Number.isFinite)) throw new Error(`${this.id}: USDT balance unavailable`);
    this.validatePositionQuantities(positions);
    // USD-M positionRisk v3 deliberately omits leverage. Read the symbol configuration;
    // initialMargin can also contain pending-order margin and is not a leverage setting.
    // https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Symbol-Config
    const active=positions.filter((p:any)=>number(p.contracts)>0);
    const leverages=new Map<string,number>();
    if(this.id==='binance')for(const symbol of new Set<string>(active.filter((p:any)=>p.leverage===undefined||p.leverage===null||p.leverage==='').map((p:any)=>p.symbol)))
      leverages.set(symbol,(await this.symbolLeverage(symbol)).leverage);
    return {freeUsd,equityUsd,positions:active.map((p:any)=> {
      const m = this.market(p.symbol);
      const leverage=leverages.get(p.symbol)??number(p.leverage);
      if (!['long','short'].includes(p.side)) throw new Error(`${this.id}: unknown position side`);
      if (!(number(p.markPrice)>0 && leverage>0)) throw new Error(`${this.id}: incomplete position risk data`);
      const liq=number(p.liquidationPrice),hasLiquidation=Number.isFinite(liq)&&liq>0;
      const margin=p.marginMode??(this.id==='okx'?p.info?.mgnMode:p.info?.marginType);
      const marginMode=margin==='isolated'||margin==='ISOLATED'?'isolated':['cross','crossed','CROSSED'].includes(margin)?'crossed':undefined;
      return {base:m.base,symbol:p.symbol,side:p.side,quantity:number(p.contracts)*number(m.contractSize),
        markPrice:number(p.markPrice),liquidationPrice:hasLiquidation?liq:0,liquidationStatus:hasLiquidation?'price':'unavailable',
        ...(!hasLiquidation?{liquidationReason:'交易所当前未返回有效单仓强平价'}:{}),leverage,
        ...(marginMode?{marginMode}:{}),
        ...positionMetrics(p.entryPrice,p.unrealizedPnl,this.id==='okx'?p.info?.fundingFee:undefined,this.id==='okx'?p.info?.fee:undefined,this.id==='okx'?p.info?.pnl:undefined),
        ...(this.id==='okx'?positionTimestamps(p.info?.cTime,p.info?.uTime):positionTimestamps(undefined,p.info?.updateTime))};
    })};
  }
  private positionQuery():Record<string,string> {
    // CCXT OKX forwards type/settle literally; Binance forwards settle literally.
    return this.id==='okx'?{instType:'SWAP'}:this.id==='binance'?{type:'swap'}:{type:'swap',settle:'USDT'};
  }
  private validatePositionQuantities(positions:any):void {
    if(!Array.isArray(positions)||positions.some((p:any)=>!(number(p.contracts)>=0)))
      throw new Error(`${this.id}: invalid position quantity data`);
  }
  private async symbolLeverage(symbol:string,marginMode:'cross'|'isolated'='isolated'):Promise<{leverage:number;marginMode:string}> {
    const m=this.market(symbol);
    if(this.id==='binance'){
      const raw=(await this.client.fetchMarginMode(symbol))?.info;
      if(!raw||raw.symbol!==m.id)throw new Error('binance: symbol configuration unavailable');
      if(!['ISOLATED','CROSSED'].includes(raw.marginType))throw new Error('binance: unknown margin mode');
      const leverage=number(raw.leverage);
      if(!(leverage>=1&&Number.isInteger(leverage)))throw new Error('binance: invalid symbol leverage');
      return {leverage,marginMode:raw.marginType==='ISOLATED'?'isolated':'cross'};
    }
    // CCXT 4.5.84 rounds leverage-info with safeInteger. Preserve official decimal strings
    // and verify the exact instrument, margin scope and net side before using the value.
    // https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-leverage
    const rows=(await this.client.fetchLeverage(symbol,{marginMode}))?.info;
    if(!Array.isArray(rows)||rows.length!==1||rows[0].instId!==m.id||rows[0].mgnMode!==marginMode||
      rows[0].posSide!=='net'||!(number(rows[0].lever)>=1))throw new Error(`okx: ${marginMode} leverage scope unavailable`);
    return {leverage:number(rows[0].lever),marginMode};
  }
  private entryMarginMode():'cross'|'isolated'{return this.config.marginMode==='crossed'?'cross':'isolated';}
  async inspectTrading(symbol:string,leverage:number):Promise<void> {
    this.assertLive(); await this.client.loadMarkets(); this.market(symbol);
    if (!(leverage >= 1 && Number.isFinite(leverage))) throw new Error('Invalid leverage');
    if(this.id==='gate')return new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode).inspectTrading(symbol,leverage);
    if(this.id==='bybit')return new BybitPrivate(this.client,this.config.marginMode).inspectTrading(symbol,leverage);
    if(this.id==='bitget'){
      const account=await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode);
      return account.inspectTrading(symbol,leverage);
    }
    // Read existing mode. Never mutate the account's one-way/hedge configuration.
    if (this.id === 'binance' || this.id === 'okx') {
      const mode = await this.client.fetchPositionMode(symbol);
      if (mode.hedged !== false || (this.id==='okx'?mode.info?.posMode!=='net_mode':mode.info?.dualSidePosition!==false))
        throw new Error(`${this.id}: configure one-way/net position mode first`);
    }
    if(this.id==='binance'&&!Number.isInteger(leverage))throw new Error('binance: invalid symbol leverage');
    if (this.id === 'binance') {
      const margin = await this.symbolLeverage(symbol);
      if (this.config.marginMode===undefined&&margin.marginMode !== 'isolated') throw new Error(`${this.id}: configure isolated margin before live entry`);
    }
    if(this.id==='okx')await this.symbolLeverage(symbol,this.entryMarginMode());
    const existing = await this.client.fetchPositions([symbol],this.positionQuery());
    this.validatePositionQuantities(existing);
    if (existing.some((p:any)=>number(p.contracts)>0)) throw new Error(`${this.id}: external/existing position on ${symbol}; entry refused`);
    if(this.id==='binance'||this.id==='okx'){
      let orders:AccountOpenOrder[];
      try{orders=await this.fetchOpenOrders(symbol);}
      catch{throw new Error(`${this.id}: complete pending order observation unavailable on ${symbol}; entry refused`);}
      if(orders.length)throw new Error(`${this.id}: external/pending order on ${symbol}; entry refused`);
    }
  }
  async prepareTrading(symbol:string,leverage:number):Promise<void> {
    this.assertLive();await this.client.loadMarkets();this.market(symbol);
    this.prepared.delete(symbol);this.preparedSettings.delete(symbol);
    if (!(leverage >= 1 && Number.isFinite(leverage))) throw new Error('Invalid leverage');
    if(this.id==='gate'){await new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode).prepare(symbol,leverage);this.prepared.add(symbol);return;}
    if(this.id==='bybit'){await new BybitPrivate(this.client,this.config.marginMode).prepare(symbol,leverage);this.prepared.add(symbol);return;}
    if(this.id==='bitget'){await (await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode)).prepare(symbol,leverage);this.prepared.add(symbol);return;}
    await this.inspectTrading(symbol,leverage);
    if(this.id==='binance'||this.id==='okx'){
      const desired=this.entryMarginMode();
      let current=await this.symbolLeverage(symbol,desired);
      if(current.marginMode!==desired){
        if(this.id!=='binance'||this.config.marginMode===undefined)throw new Error(`${this.id}: configure isolated margin before live entry`);
        // Only an explicit new-entry preference can change this flat contract's margin mode.
        // Also guard native conditional orders before the margin write.
        const conditional=await this.client.fapiPrivateGetOpenAlgoOrders({symbol:this.market(symbol).id});
        if(!Array.isArray(conditional)||conditional.length)throw new Error('binance: external/pending conditional order; margin change refused');
        await this.client.setMarginMode(desired,symbol);
        current=await this.symbolLeverage(symbol,desired);
        if(current.marginMode!==desired)throw new Error('binance: unable to verify requested margin mode');
      }
      if(current.leverage!==leverage){
        if(this.id==='binance')await this.client.setLeverage(leverage,symbol);
        // OKX selects the contract margin scope on the order; its account position mode is preserved.
        // https://www.okx.com/docs-v5/en/#trading-account-rest-api-set-leverage
        else await this.client.privatePostAccountSetLeverage({instId:this.market(symbol).id,mgnMode:desired,lever:String(leverage)});
        const checked=await this.symbolLeverage(symbol,desired);
        if(checked.marginMode!==desired||checked.leverage!==leverage)
          throw new Error(`${this.id}: unable to verify requested leverage`);
      }
      this.preparedSettings.set(symbol,{leverage,marginMode:desired});
      this.prepared.add(symbol);return;
    }
    throw new Error('Venue requires its dedicated preparation path');
  }
  private orderParams(request:OrderRequest,marginMode:'cross'|'isolated'='isolated'):any {
    const clientOrderId = exchangeClientId(this.id,request.clientOrderId);
    const common = {timeInForce:'IOC',reduceOnly:request.reduceOnly};
    if (this.id === 'binance') return {...common,newClientOrderId:clientOrderId,positionSide:'BOTH',newOrderRespType:'RESULT'};
    if (this.id === 'okx') return {...common,clOrdId:clientOrderId,tdMode:marginMode,posSide:'net'};
    throw new Error('Venue requires its dedicated order path');
  }
  private async orderMarginMode(request:OrderRequest):Promise<'cross'|'isolated'>{
    if(this.id!=='okx')return this.entryMarginMode();
    if(!request.reduceOnly)return this.entryMarginMode();
    // An existing position keeps its native margin scope, even when the next entry uses another mode.
    const positions=await this.client.fetchPositions([request.symbol],this.positionQuery());
    this.validatePositionQuantities(positions);
    const targets=positions.filter((p:any)=>p.symbol===request.symbol&&number(p.contracts)>0&&p.side===(request.side==='buy'?'short':'long'));
    if(!targets.length){
      if(this.config.marginMode===undefined)return 'isolated'; // Retain the legacy flat reduce-only request path.
      throw new Error('okx: native position margin scope unavailable for reduction');
    }
    const modes=new Set(targets.map((p:any)=>p.info?.mgnMode));
    const mode=[...modes][0];
    if(modes.size!==1||!['cross','isolated'].includes(mode as string)||targets.some((p:any)=>p.info?.posSide!=='net'))
      throw new Error('okx: ambiguous native position margin scope; reduction refused');
    return mode as 'cross'|'isolated';
  }
  private orderValues(request:OrderRequest,makerReduction=false):{market:any;contracts:number;boundedPrice:number}{
    const m=this.market(request.symbol);
    const refuse=(message:string,code:string,reason:string):never=>{throw new OrderNotSubmittedError(message,code,reason);};
    if(request.postOnly!==undefined&&typeof request.postOnly!=='boolean'||request.postOnly&&
      (!['gate','bybit','bitget'].includes(this.id)||!makerReduction&&(request.reduceOnly||request.closePosition)))
      refuse('Unsupported Maker entry selector','INVALID_MAKER_ORDER','Maker 试运行仅支持 Gate、Bybit、Bitget 的入场首腿，本次未发送订单');
    if(request.closePosition&&(!request.reduceOnly||this.id!=='gate'))
      refuse('Unsupported exact close selector','INVALID_CLOSE_SELECTOR','该交易所不支持当前精确分仓委托，订单未发送');
    if(m.base!==request.base||!['buy','sell'].includes(request.side)||!Number.isFinite(request.quantity)||!Number.isFinite(request.limitPrice)||
      !(request.quantity>0&&request.limitPrice>0))refuse('Invalid order base/quantity/limit','INVALID_ORDER_PARAMETERS','本地下单参数无效，本次未发送订单');
    let units:ReturnType<typeof marketOrderUnits>;
    try{units=marketOrderUnits(this.id,m,this.client.precisionMode,request.reduceOnly);}
    catch{refuse('Order unit rules unavailable or conflicting','ORDER_RULES_UNAVAILABLE','数量步长或下限规则缺失／矛盾，本次未发送订单');}
    let contracts=NaN,price=NaN;
    try{
      // Both entry and reduction use decimal division. A valid 0.6 / 0.1 is six
      // contracts; the original coin quantity is never rounded up or replaced.
      const divisionPrecision=Math.max(18,quantityGrid([units!.contractStep])!.decimals+16);
      const contractQuantity=ccxt.Precise.stringDiv(String(request.quantity),String(units!.contractSize),divisionPrecision);
      contracts=Number(this.client.amountToPrecision(request.symbol,contractQuantity));price=Number(this.client.priceToPrecision(request.symbol,request.limitPrice));
    }
    catch{refuse('Order precision conversion failed','INVALID_ORDER_PRECISION','数量或价格无法按交易所精度转换，本次未发送订单');}
    const nativeQuantity=multiplyQuantity(contracts,units!.contractSize),tolerance=Number.EPSILON*Math.max(Math.abs(nativeQuantity),Math.abs(request.quantity))*8;
    if(!isQuantityOnStep(request.quantity,units!.quantityStep)||!isQuantityOnStep(contracts,units!.contractStep)||
      !Number.isFinite(nativeQuantity)||Math.abs(nativeQuantity-request.quantity)>tolerance)
      refuse('Order quantity does not match exchange lot size','INVALID_ORDER_QUANTITY','数量不符合交易所最小步长，本次未发送订单');
    const step=this.client.precisionMode===4?number(m.precision.price):10**-number(m.precision.price);
    const inward=request.side==='buy'&&price>request.limitPrice?price-step:request.side==='sell'&&price<request.limitPrice?price+step:price;
    const boundedPrice=Number(this.client.priceToPrecision(request.symbol,inward));
    if(!Number.isFinite(boundedPrice)||!(boundedPrice>0)||(request.side==='buy'?boundedPrice>request.limitPrice:boundedPrice<request.limitPrice))
      refuse('Order price exceeds configured limit','INVALID_ORDER_PRICE','交易所价格精度无法满足委托限价，本次未发送订单');
    if(!(contracts>0)||nativeQuantity<units!.minQuantity||units!.maxQuantity!==undefined&&nativeQuantity>units!.maxQuantity||
      (!request.reduceOnly&&multiplyQuantity(nativeQuantity,boundedPrice)<units!.minNotional))
      refuse('Order is below minimum quantity/notional or exceeds maximum','INVALID_ORDER_SIZE','数量或名义价值不符合交易所上下限，本次未发送订单');
    return {market:m,contracts,boundedPrice};
  }
  private async validatedOrderValues(request:OrderRequest):Promise<ReturnType<CcxtAdapter['orderValues']>>{
    await this.client.loadMarkets();const values=this.orderValues(request);
    if(this.id==='bybit')assertBybitEntryEligibility(values.market,request);
    return values;
  }
  /** Confirmed Maker peers still receive native account/slot checks inside placeOrder before POST. */
  async validateOrderLocally(request:OrderRequest):Promise<void>{await this.validatedOrderValues(request);}
  /** Local/public checks and GET-only native slot validation. Never changes leverage or submits/cancels orders. */
  async validateOrder(request:OrderRequest):Promise<void>{
    const values=await this.validatedOrderValues(request);
    if(request.reduceOnly&&this.id==='gate')await new GatePrivate(this.client).validateReduction(request,values.contracts);
    if(request.reduceOnly&&this.id==='bybit')await new BybitPrivate(this.client,this.config.marginMode).validateReduction(request,values.contracts);
  }
  supportsMakerReduction():boolean{return ['gate','bybit','bitget'].includes(this.id);}
  private assertMakerReduction(request:OrderRequest):void{
    assertMakerReductionRequest(request);
    if(!this.supportsMakerReduction())throw new OrderNotSubmittedError('Maker reduction venue unsupported','INVALID_MAKER_ORDER','该交易所尚未验证 Maker 减仓接口');
    if(request.closePosition&&this.id!=='gate')throw new OrderNotSubmittedError('Exact Maker reduction slot unsupported','INVALID_CLOSE_SELECTOR','该交易所不支持当前精确分仓减仓委托');
  }
  private async makerReductionAccount():Promise<NativeMakerReductionAccount>{
    if(this.id==='gate')return new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode);
    if(this.id==='bybit')return new BybitPrivate(this.client,this.config.marginMode);
    if(this.id==='bitget')return bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode);
    throw new Error('Maker reduction venue unsupported');
  }
  async validateMakerReduction(request:OrderRequest):Promise<void>{
    this.assertLive();this.assertMakerReduction(request);
    await this.client.loadMarkets();const values=this.orderValues(request,true);
    if(this.id==='gate')await new GatePrivate(this.client).validateReduction(request,values.contracts);
    if(this.id==='bybit')await new BybitPrivate(this.client,this.config.marginMode).validateReduction(request,values.contracts);
    if(this.id==='bitget')await (await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode)).assertTradingMode(request.symbol);
  }
  /** Separate ACK-only route. A repeated ID returns retained evidence without GET, cancel or another create. */
  async submitMakerReduction(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>{
    const signature=JSON.stringify(request),prior=this.makerReductions.get(request.clientOrderId);
    if(prior){if(prior.request!==signature)throw new Error('Maker reduction client ID reused with different request');return {...prior.result};}
    if(this.submitted.has(request.clientOrderId))throw new Error('Client ID already belongs to the ordinary order route');
    let values:ReturnType<CcxtAdapter['orderValues']>,account:NativeMakerReductionAccount;
    try{
      this.assertLive();this.assertMakerReduction(request);
      await this.client.loadMarkets();values=this.orderValues(request,true);account=await this.makerReductionAccount();
      if(this.submitted.has(request.clientOrderId))throw new Error('Client ID already belongs to the ordinary order route');
    }catch(error){
      const concurrent=this.makerReductions.get(request.clientOrderId);
      if(concurrent){if(concurrent.request!==signature)throw new Error('Maker reduction client ID reused with different request');return {...concurrent.result};}
      if(this.submitted.has(request.clientOrderId))throw new Error('Client ID already belongs to the ordinary order route');
      const refusal=error instanceof OrderNotSubmittedError?error:new OrderNotSubmittedError('Maker reduction preflight failed','PRE_SUBMISSION_CHECK_FAILED','Maker 减仓提交前核验失败，本次未发送创建请求');
      const result={...rejectedOrder(request,refusal),confirmation:confirmation(this.id,'pre-submit','pre-submit-failed',error)};
      this.makerReductions.set(request.clientOrderId,{request:signature,result});return result;
    }
    const concurrent=this.makerReductions.get(request.clientOrderId);
    if(concurrent){if(concurrent.request!==signature)throw new Error('Maker reduction client ID reused with different request');return {...concurrent.result};}
    if(this.submitted.has(request.clientOrderId))throw new Error('Client ID already belongs to the ordinary order route');
    const pending=unknownOrder(request);this.makerReductions.set(request.clientOrderId,{request:signature,result:pending});
    try{
      const orderId=await account.placeMakerReduction(request,values.contracts,values.boundedPrice,canSubmit);
      if(orderId)pending.id=orderId;
      else pending.confirmation=confirmation(this.id,'create','acknowledgement-missing');
    }catch(error){
      if(error instanceof OrderNotSubmittedError){
        const result=rejectedOrder(request,error);this.makerReductions.set(request.clientOrderId,{request:signature,result});return result;
      }
      // A transport error may hide a live order. The supervisor only inspects this original client ID.
      pending.confirmation=confirmation(this.id,'create','request-failed',error);
    }
    return {...pending};
  }
  async inspectMakerReduction(request:OrderRequest,orderId?:string):Promise<MakerReductionObservation>{
    this.assertMakerReduction(request);
    const signature=JSON.stringify(request),known=this.makerReductions.get(request.clientOrderId);
    if(known&&known.request!==signature)throw new Error('Maker reduction client ID reused with different request');
    const prior=known?.result??unknownOrder(request,orderId);
    if(orderId&&prior.id&&orderId!==prior.id)throw new Error('Maker reduction native ID changed');
    if(prior.status==='cancelled'&&!prior.id&&prior.filledQuantity===0&&prior.rejectionCode)
      return {activity:'terminal',executionVerified:true,result:{...prior},observedAt:Date.now()};
    try{
      await this.client.loadMarkets();const account=await this.makerReductionAccount();
      const observation=await account.inspectMakerReduction(request,prior,orderId??(prior.id||undefined));
      const latest=this.makerReductions.get(request.clientOrderId)?.result;
      if(observation.executionVerified&&latest&&(observation.result.id!==latest.id&&latest.id||
        observation.result.filledQuantity<latest.filledQuantity||latest.status!=='unknown'&&observation.activity==='active'))return unknownMakerReduction(latest);
      if(observation.executionVerified)this.makerReductions.set(request.clientOrderId,{request:signature,result:{...observation.result}});
      return observation;
    }catch{return unknownMakerReduction(this.makerReductions.get(request.clientOrderId)?.result??prior);}
  }
  async cancelMakerReduction(request:OrderRequest,orderId:string):Promise<void>{
    this.assertLive();this.assertMakerReduction(request);
    if(typeof orderId!=='string'||!orderId)throw new Error('Maker reduction cancellation requires an exact native ID');
    const known=this.makerReductions.get(request.clientOrderId);
    if(known&&(known.request!==JSON.stringify(request)||known.result.id&&known.result.id!==orderId))throw new Error('Maker reduction cancellation identity mismatch');
    await this.client.loadMarkets();await (await this.makerReductionAccount()).cancel(request.symbol,orderId);
  }
  private async retainedOrder(request:OrderRequest,prior:{request:string;result:OrderResult}):Promise<OrderResult> {
    if(request.postOnly&&this.makerPending.has(request.clientOrderId))return this.makerPending.get(request.clientOrderId)!;
    if(prior.result.status!=='unknown')return prior.result;
    try{return await this.reconcileOrder(request,prior.result.id||undefined);}
    catch(error){return {...prior.result,status:'unknown',confirmation:confirmation(this.id,'order-read','request-failed',error)};}
  }
  async placeOrder(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult> {
    if(this.makerReductions.has(request.clientOrderId))throw new Error('Maker reduction original must use its supervised route');
    const signature = JSON.stringify(request), prior = this.submitted.get(request.clientOrderId);
    if (prior) {
      if (prior.request !== signature) throw new Error('Client order ID reused with different order details');
      return this.retainedOrder(request,prior);
    }
    let values:ReturnType<CcxtAdapter['orderValues']>,orderMargin:'cross'|'isolated';
    try{
      this.assertLive();
      if(!request.reduceOnly&&!this.prepared.has(request.symbol))throw new Error(`${this.id}: prepareTrading must succeed before opening orders`);
      await this.client.loadMarkets();
      // A same-ID call may already have submitted while this metadata read was in flight.
      const concurrent=this.submitted.get(request.clientOrderId);
      if(concurrent){if(concurrent.request!==signature)throw new Error('Client order ID reused with different order details');return this.retainedOrder(request,concurrent);}
      values=this.orderValues(request);
      if(this.id==='bybit')assertBybitEntryEligibility(values.market,request);
      orderMargin=await this.orderMarginMode(request);
      if(!request.reduceOnly&&this.config.marginMode!==undefined&&['binance','okx'].includes(this.id)){
        const expected=this.preparedSettings.get(request.symbol),actual=await this.symbolLeverage(request.symbol,this.entryMarginMode());
        if(!expected||actual.leverage!==expected.leverage||actual.marginMode!==expected.marginMode)throw new Error(`${this.id}: prepared leverage/margin changed before order`);
      }
      if(this.id==='bitget')await (await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode)).assertTradingMode(request.symbol);
    }catch(error){
      const concurrent=this.submitted.get(request.clientOrderId);
      if(concurrent){if(concurrent.request!==signature)throw new Error('Client order ID reused with different order details');return this.retainedOrder(request,concurrent);}
      const refusal=error instanceof OrderNotSubmittedError?error:new OrderNotSubmittedError('Order pre-submission check failed','PRE_SUBMISSION_CHECK_FAILED','委托发送前检查失败，本次未发送创建订单请求');
      const result={...rejectedOrder(request,refusal),confirmation:confirmation(this.id,'pre-submit','pre-submit-failed',error)};this.submitted.set(request.clientOrderId,{request:signature,result});return result;
    }
    const {market:m,contracts,boundedPrice}=values;
    if(this.makerReductions.has(request.clientOrderId))throw new Error('Maker reduction original must use its supervised route');
    const concurrent=this.submitted.get(request.clientOrderId);
    if(concurrent){if(concurrent.request!==signature)throw new Error('Client order ID reused with different order details');return this.retainedOrder(request,concurrent);}
    const pending = unknownOrder(request);
    if(this.id==='okx')this.okxSubmittedMargins.set(request.clientOrderId,orderMargin);
    this.submitted.set(request.clientOrderId,{request:signature,result:pending});
    // Native slot selectors require the REST response's margin/PID checks. The
    // generic private stream normalizes those fields away, so cannot confirm them.
    if(!request.closePosition&&!request.postOnly)this.privateEvents?.observe(request,exchangeClientId(this.id,request.clientOrderId),number(m.contractSize),
      this.id==='binance'||this.id==='okx'?{posSide:'net',limitPrice:boundedPrice,...(this.id==='okx'?{marginMode:orderMargin}:{})}:undefined);
    let stage:OrderConfirmationDiagnostic['stage']='create';
    try {
      if(this.id==='gate'){
        const account=new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode);
        if(request.postOnly)return await this.placeNativeMaker(account,request,contracts,boundedPrice,pending,signature,canSubmit);
        this.rememberNativeStreamAccount(request,account);
        const orderId=await account.place(request,contracts,boundedPrice,canSubmit);
        if(orderId)pending.id=orderId;
        stage='receipt';
        if(!request.closePosition)this.privateEvents?.observe(request,exchangeClientId(this.id,request.clientOrderId),number(m.contractSize),account.submissionIdentity(request));
        const result=(!request.closePosition?await this.privateEvents?.wait(request,orderId,150):undefined)??await account.reconcile(request,pending,orderId);this.submitted.set(request.clientOrderId,{request:signature,result});return result;
      }
      if(this.id==='bybit'){
        const account=new BybitPrivate(this.client,this.config.marginMode);
        if(request.postOnly)return await this.placeNativeMaker(account,request,contracts,boundedPrice,pending,signature,canSubmit);
        this.rememberNativeStreamAccount(request,account);
        const orderId=await account.place(request,contracts,boundedPrice,canSubmit);
        if(orderId)pending.id=orderId;
        stage='receipt';
        if(!request.closePosition)this.privateEvents?.observe(request,exchangeClientId(this.id,request.clientOrderId),number(m.contractSize),account.submissionIdentity(request));
        const result=(!request.closePosition?await this.privateEvents?.wait(request,orderId,150):undefined)??await account.reconcile(request,pending,orderId);this.submitted.set(request.clientOrderId,{request:signature,result});return result;
      }
      if(this.id==='bitget'){
        if(request.postOnly)return await this.placeNativeMaker(bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode),request,contracts,boundedPrice,pending,signature,canSubmit);
        const account=await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode);
        this.rememberNativeStreamAccount(request,account);
        const orderId=await account.place(request,contracts,boundedPrice,canSubmit);
        if(orderId)pending.id=orderId;
        stage='receipt';
        if(!request.closePosition)this.privateEvents?.observe(request,exchangeClientId(this.id,request.clientOrderId),number(m.contractSize),account.submissionIdentity(request));
        const result=(!request.closePosition?await this.privateEvents?.wait(request,orderId,150):undefined)??await account.reconcile(request,pending,orderId);this.submitted.set(request.clientOrderId,{request:signature,result});return result;
      }
      assertOrderSubmissionPermission(canSubmit);
      const raw = await this.client.createOrder(request.symbol,'limit',request.side,contracts,boundedPrice,this.orderParams(request,orderMargin));
      stage='receipt';
      // Preserve an acknowledged native ID even if this ACK has no execution fields.
      // Parsing failure must query that exact order instead of discarding its identity.
      if(typeof raw?.id==='string'&&raw.id||typeof raw?.id==='number'&&Number.isSafeInteger(raw.id))pending.id=String(raw.id);
      if(!request.closePosition)this.privateEvents?.observe(request,exchangeClientId(this.id,request.clientOrderId),number(m.contractSize),
        {posSide:'net',limitPrice:boundedPrice,...(this.id==='okx'?{marginMode:orderMargin}:{})});
      const result = (!request.closePosition?await this.privateEvents?.wait(request,raw?.id?String(raw.id):undefined,150):undefined)??await this.orderResult(raw,request,m);
      this.submitted.set(request.clientOrderId,{request:signature,result});
      return result.status === 'unknown' ? this.reconcileOrder(request,result.id || undefined) : result;
    } catch(error) {
      if(error instanceof OrderNotSubmittedError){
        const result=rejectedOrder(request,error);this.submitted.set(request.clientOrderId,{request:signature,result});return result;
      }
      // A network timeout may have reached the exchange: query by deterministic ID, NEVER resend.
      let result:OrderResult;
      try{result=await this.reconcileOrder(request);}
      catch{result={...(this.submitted.get(request.clientOrderId)?.result??pending),status:'unknown'};}
      if(result.status==='unknown'&&!result.confirmation)result={...result,confirmation:confirmation(this.id,stage,'request-failed',error)};
      this.submitted.set(request.clientOrderId,{request:signature,result});return result;
    }
  }
  private rememberNativeStreamAccount(request:OrderRequest,account:NativeStreamAccount):void{
    if(this.nativeStreamAccounts.size>=MAX_PRIVATE_SUBMISSIONS&&!this.nativeStreamAccounts.has(request.clientOrderId))
      this.nativeStreamAccounts.delete(this.nativeStreamAccounts.keys().next().value!);
    this.nativeStreamAccounts.set(request.clientOrderId,account);
  }
  private async placeNativeMaker(accountOrPending:NativeMakerAccount|Promise<NativeMakerAccount>,
    request:OrderRequest,quantity:number,price:number,prior:OrderResult,signature:string,canSubmit?:()=>boolean):Promise<OrderResult>{
    const pending=(async()=>{
      const account=await accountOrPending;
      const orderId=await account.place(request,quantity,price,canSubmit);
      const result=await settleNativeMakerOrder(request,prior,orderId,{inspect:(known,id)=>account.inspectOrder(request,known,id),
        cancel:id=>account.cancel(request.symbol,id)});
      this.submitted.set(request.clientOrderId,{request:signature,result});return result;
    })();
    this.makerPending.set(request.clientOrderId,pending);
    try{return await pending;}finally{if(this.makerPending.get(request.clientOrderId)===pending)this.makerPending.delete(request.clientOrderId);}
  }
  async reconcileOrder(request:OrderRequest,orderId?:string):Promise<OrderResult> {
    // Generic reconciliation cancels anomalously open IOC/entry orders. It must never own a supervised resting reduction.
    if(request.reduceOnly&&request.postOnly)throw new Error('Maker reduction original requires inspectMakerReduction');
    this.assertLive(); await this.client.loadMarkets(); const m = this.market(request.symbol);
    const clientId = exchangeClientId(this.id,request.clientOrderId);
    const known=this.submitted.get(request.clientOrderId);
    if(known&&known.request!==JSON.stringify(request))throw new Error('Client order ID reused with different order details');
    if(request.postOnly&&this.makerPending.has(request.clientOrderId))return this.makerPending.get(request.clientOrderId)!;
    const prior = known?.result ?? unknownOrder(request,orderId);
    if(prior.rejectionCode&&prior.status==='cancelled'&&prior.filledQuantity===0&&!prior.id)return prior;
    if(!request.closePosition&&!request.postOnly)this.privateEvents?.observe(request,clientId,number(m.contractSize),
      this.nativeStreamAccounts.get(request.clientOrderId)?.submissionIdentity(request));
    const pushed=!request.closePosition&&!request.postOnly?this.privateEvents?.result(request,orderId??prior.id):undefined;
    if(pushed&&pushed.filledQuantity+1e-12>=prior.filledQuantity){this.submitted.set(request.clientOrderId,{request:JSON.stringify(request),result:pushed});return pushed;}
    if(this.id==='gate'){
      const result=await new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode).reconcile(request,prior,orderId);
      this.submitted.set(request.clientOrderId,{request:JSON.stringify(request),result});return result;
    }
    if(this.id==='bybit'){
      const result=await new BybitPrivate(this.client,this.config.marginMode).reconcile(request,prior,orderId);
      this.submitted.set(request.clientOrderId,{request:JSON.stringify(request),result});return result;
    }
    if(this.id==='bitget'){
      const result=await (await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode)).reconcile(request,prior,orderId);
      this.submitted.set(request.clientOrderId,{request:JSON.stringify(request),result});return result;
    }
    let confirmed=prior;
    try {
      const exactId=orderId??(prior.id||undefined);
      const raw = await this.client.fetchOrder(exactId ?? clientId,request.symbol,exactId ? {} : {clientOrderId:clientId});
      let result = await this.orderResult(raw,request,m,exactId);
      if (result.filledQuantity+1e-12 < confirmed.filledQuantity) throw new Error('Regressive cumulative order execution');
      confirmed=result;
      if (result.status === 'unknown' && raw.status === 'open' && result.id) {
        // IOC should be terminal; explicitly cancel anomalously open orders before retrying a query.
        await this.client.cancelOrder(result.id,request.symbol);
        const final = await this.client.fetchOrder(result.id,request.symbol);
        if (final){
          result=await this.orderResult(final,request,m,confirmed.id);
          if(result.filledQuantity+1e-12<confirmed.filledQuantity)throw new Error('Regressive cancellation execution');
          confirmed=result;
        }
      }
      this.submitted.set(request.clientOrderId,{request:JSON.stringify(request),result}); return result;
    } catch {
      const result={...confirmed,status:'unknown' as const};
      this.submitted.set(request.clientOrderId,{request:JSON.stringify(request),result});return result;
    }
  }
  private async orderResult(raw:any,request:OrderRequest,m:any,expectedId?:string):Promise<OrderResult> {
    const numeric=(value:unknown)=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
    if(this.id==='binance'||this.id==='okx'){
      // CCXT's unified order omits or normalizes execution selectors. A matching
      // ID/quantity cannot turn a native opening, hedge-side or GTC receipt into
      // confirmation of this net-mode reduce-only/IOC request.
      const info=raw?.info,binance=this.id==='binance',present=(value:unknown)=>value!==undefined,
        bool=(value:unknown)=>value===true||value==='true'?true:value===false||value==='false'?false:undefined;
      if(present(raw?.reduceOnly)&&bool(raw.reduceOnly)!==request.reduceOnly||
        present(raw?.timeInForce)&&raw.timeInForce!=='IOC'||raw?.postOnly===true)
        throw new Error('Native order action or IOC selector does not match');
      if(info&&typeof info==='object'){
        const clientId=binance?info.clientOrderId:info.clOrdId,nativeSymbol=binance?info.symbol:info.instId,
          quantity=binance?info.origQty:info.sz,mode=this.okxSubmittedMargins.get(request.clientOrderId)??
            (request.closePosition?.marginMode==='crossed'?'cross':request.closePosition?.marginMode),
          tolerance=Math.max(1e-12,request.quantity*1e-9);
        if(present(clientId)&&clientId!==exchangeClientId(this.id,request.clientOrderId)||
          present(nativeSymbol)&&nativeSymbol!==m.id||
          present(info.side)&&info.side!==(binance?request.side.toUpperCase():request.side)||
          present(info.reduceOnly)&&bool(info.reduceOnly)!==request.reduceOnly||
          present(quantity)&&(!Number.isFinite(numeric(quantity))||Math.abs(numeric(quantity)*number(m.contractSize)-request.quantity)>tolerance)||
          binance&&(present(info.positionSide)&&info.positionSide!=='BOTH'||present(info.timeInForce)&&info.timeInForce!=='IOC'||
            present(info.type)&&info.type!=='LIMIT'||present(info.origType)&&info.origType!=='LIMIT')||
          !binance&&(present(info.posSide)&&info.posSide!=='net'||present(info.ordType)&&info.ordType!=='ioc'||
            present(info.tdMode)&&(!['cross','isolated'].includes(info.tdMode)||mode!==undefined&&info.tdMode!==mode)))
          throw new Error('Native order action, position scope or IOC identity does not match');
      }
    }
    const nativeId=typeof raw?.id==='string'&&raw.id||typeof raw?.id==='number'&&Number.isSafeInteger(raw.id)?String(raw.id):'';
    const filledQuantity=numeric(raw?.filled)*number(m.contractSize);
    const quantityTolerance=Math.max(1e-12,request.quantity*1e-9);
    const averagePrice=filledQuantity>0?(raw?.average!==undefined&&raw.average!==null&&raw.average!==''
      ?numeric(raw.average):numeric(raw?.cost)/filledQuantity):0;
    const priceTolerance=Math.max(1e-12,request.limitPrice*1e-12);
    // These optional unified fields may be absent in a create ACK. Whenever present,
    // they must agree; a GET by an exact native ID must always return that same ID.
    // A missing cumulative fill is unknown, never a proved zero-fill cancellation.
    if(!nativeId||expectedId&&nativeId!==expectedId||
      raw.symbol!=null&&raw.symbol!==request.symbol||raw.side!=null&&raw.side!==request.side||
      raw.type!=null&&raw.type!=='limit'||raw.clientOrderId!=null&&raw.clientOrderId!==''&&raw.clientOrderId!==exchangeClientId(this.id,request.clientOrderId)||
      raw.amount!=null&&(!Number.isFinite(numeric(raw.amount))||Math.abs(numeric(raw.amount)*number(m.contractSize)-request.quantity)>quantityTolerance)||
      !Number.isFinite(filledQuantity)||filledQuantity<0||filledQuantity>request.quantity+quantityTolerance||
      filledQuantity>0&&(!Number.isFinite(averagePrice)||averagePrice<=0||
        (request.side==='buy'?averagePrice>request.limitPrice+priceTolerance:averagePrice<request.limitPrice-priceTolerance)))
      throw new Error('Order identity or cumulative execution cannot be verified');
    const terminal = ['closed','canceled','cancelled','expired','rejected'].includes(raw.status);
    const validFill = filledQuantity === 0 || averagePrice > 0;
    const status = !terminal || !validFill ? 'unknown' : filledQuantity >= request.quantity*(1-1e-8) ? 'filled' : filledQuantity>0 ? 'partial' : 'cancelled';
    let fees:any[] = raw.fees?.length ? raw.fees : raw.fee ? [raw.fee] : [];
    if (!fees.length && filledQuantity > 0 && this.client.has?.fetchMyTrades) {
      try {
        const trades = await this.client.fetchMyTrades(request.symbol,number(raw.timestamp,Date.now())-60000,100,{orderId:raw.id});
        const relevant = trades.filter((t:any)=>String(t.order)===String(raw.id));
        const seen=new Map<string,string>(),cash:any[]=[];let quantity=0;
        for(const trade of relevant){
          const executionId=typeof trade.id==='string'&&trade.id||typeof trade.id==='number'&&Number.isSafeInteger(trade.id)?String(trade.id):'';
          const baseQuantity=numeric(trade.amount)*number(m.contractSize);
          const paid=Array.isArray(trade.fees)&&trade.fees.length?trade.fees:trade.fee?[trade.fee]:[];
          if(!executionId||!Number.isFinite(baseQuantity)||baseQuantity<=0||trade.symbol!=null&&trade.symbol!==request.symbol||
            trade.side!=null&&trade.side!==request.side||trade.clientOrderId!=null&&trade.clientOrderId!==''&&trade.clientOrderId!==exchangeClientId(this.id,request.clientOrderId)||
            !paid.length||paid.some((fee:any)=>fee?.currency!=='USDT'||!Number.isFinite(numeric(fee?.cost))))
            throw new Error('Order cash execution is incomplete or mismatched');
          const signature=JSON.stringify([baseQuantity,paid.map((fee:any)=>numeric(fee.cost))]),prior=seen.get(executionId);
          if(prior!==undefined){if(prior!==signature)throw new Error('Conflicting duplicate order cash execution');continue;}
          seen.set(executionId,signature);quantity+=baseQuantity;cash.push(...paid);
        }
        // Paginated/overlapping fills cannot add cash twice or omit the fee on one
        // confirmed execution. Extra or missing quantity is unresolved evidence.
        if(Math.abs(quantity-filledQuantity)<=Math.max(1e-12,filledQuantity*1e-9))fees=cash;
      } catch { /* Missing actual cash fees keep the original order unresolved. */ }
    }
    const feesKnown=filledQuantity===0||fees.length>0&&fees.every(f=>Number.isFinite(numeric(f.cost))&&f.currency==='USDT');
    const feeUsd=feesKnown?fees.reduce((sum,fee)=>sum+numeric(fee.cost),0):NaN;
    return {id:String(raw.id ?? ''),clientOrderId:request.clientOrderId,status:feesKnown?status:'unknown',filledQuantity,averagePrice:number(averagePrice,0),feeUsd,timestamp:number(raw.lastTradeTimestamp ?? raw.timestamp,Date.now())};
  }
  async cancelOrder(symbol:string,orderId:string):Promise<void> {
    this.assertLive();
    if(this.id==='gate'){await this.client.loadMarkets();await new GatePrivate(this.client,this.config.takerFees.gate,this.config.marginMode).cancel(symbol,orderId);return;}
    if(this.id==='bitget'){await this.client.loadMarkets();await (await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode)).cancel(symbol,orderId);return;}
    if(this.id==='bybit'){await this.client.loadMarkets();await new BybitPrivate(this.client,this.config.marginMode).cancel(symbol,orderId);return;}
    await this.client.cancelOrder(orderId,symbol);
  }
  async fetchFundingPayments(since:number,context?:PrivateReadContext):Promise<FundingPayment[]> {
    return withExchangeRequestContext(this.client,context??{},async()=>{
      assertExchangeRequestActive(this.client,this.id);
      this.assertLive(); await this.client.loadMarkets();
      assertExchangeRequestActive(this.client,this.id);
      if(this.id==='bitget'){
        const account=await bitgetAccount(this.client,this.config.bitgetNewSymbolMarginMode??'isolated',this.config.marginMode);
        assertExchangeRequestActive(this.client,this.id);
        if('fetchFundingPayments' in account){
          const payments=await account.fetchFundingPayments(since);
          assertExchangeRequestActive(this.client,this.id);
          return payments;
        }
      }
      const payments=await readFundingLedger(this.client,this.id,since);
      assertExchangeRequestActive(this.client,this.id);
      return payments;
    });
  }
  async close():Promise<void> { this.closed=true;this.realtimePublish=undefined;this.historyQueue=[];this.portfolioCash?.stop();this.tradingFees?.stop();if(this.id==='bitget')clearBitgetAccountCache(this.client);await Promise.allSettled([this.publicBooks?.close(),this.privateEvents?.close()]);if (typeof this.client.close==='function') await this.client.close(); }
}
