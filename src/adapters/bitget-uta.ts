import { positionMetrics, positionTimestamps } from './position-metrics.js';
import type { AccountOpenOrder, AccountOverview, AccountPosition, AccountState, FundingPayment, MakerReductionObservation, OrderRequest, OrderResult } from '../shared/types.js';
import { exchangeClientId, isEligibleMarket, number, unknownOrder } from './normalization.js';
import {bitgetTradingModeVersion,cachedBitgetTradingMode,clearBitgetAccountCache,invalidateBitgetTradingModes,readVerifiedBitgetSettings,rememberBitgetTradingMode} from './bitget-account.js';
import {assertMakerReductionPermission,assertMakerReductionRequest,unknownMakerReduction,verifiedMakerReduction} from './maker-reduction-observation.js';
import {OrderNotSubmittedError} from './order-rejection.js';
import {assertOrderSubmissionPermission} from './order-submission-permission.js';
import {assertExchangeRequestActive} from './network.js';

const CATEGORY='USDT-FUTURES',DAY=86400000;
const submittedIdentities=new WeakMap<object,Map<string,{signature:string;marginMode:'cross'|'isolated';posSide:'net'|'long'|'short';limitPrice:number;makerReduction?:true;guardedSubmission?:true;id?:string;rejection?:OrderNotSubmittedError}>>();
const FUNDING_TYPES=new Set(['CONTRACT_MAIN_SETTLE_FEE_USER_IN','CONTRACT_MAIN_SETTLE_FEE_USER_OUT',
  'MARGIN_SETTLE_FEE_USER_IN','MARGIN_SETTLE_FEE_USER_OUT','FIXED_SETTLE_FEE_USER_IN','FIXED_SETTLE_FEE_USER_OUT']);
function numeric(value:unknown):number {
  return typeof value==='number'||typeof value==='string'&&value.trim()!==''?number(value):NaN;
}
export function bitgetUtaData(response:any):any {
  if(response?.code!=='00000'||response.data===undefined||response.data===null)throw new Error('bitget: UTA response unavailable; verify unified account and UTA permissions');
  return response.data;
}
function list(data:any):any[]{
  if(!Array.isArray(data?.list))throw new Error('bitget: invalid UTA list response');
  return data.list;
}
function validSettings(settings:any):void {
  if(settings?.accountMode!=='unified')throw new Error('bitget: verified unified account required; account transition or hybrid mode cannot use UTA execution');
}
function assertAccountMode(settings:any):void {
  validSettings(settings);
  if(!['basic','isolated'].includes(settings.accountLevel)||settings.deltaSwitch==='yes')throw new Error('bitget: UTA advanced/delta/unknown collateral modes are read-only');
  if(!['one_way_mode','hedge_mode'].includes(settings.holdMode))throw new Error('bitget: UTA holding mode must be verified');
}
function positionSide(request:OrderRequest):'long'|'short'{
  return request.reduceOnly?(request.side==='sell'?'long':'short'):(request.side==='buy'?'long':'short');
}
interface SymbolConfig {
  marginMode:'crossed'|'isolated';holdMode:'one_way_mode'|'hedge_mode';accountLevel:string;
  longLeverage:number;shortLeverage:number;
}

/** Explicit v3 USDT futures adapter. Authentication, permissions and durable order idempotency live in CcxtAdapter/Engine. */
export class BitgetUta {
  constructor(private readonly client:any,private readonly newSymbolMarginMode:'crossed'|'isolated'='isolated',private readonly desiredMarginMode?:'crossed'|'isolated'){}
  private async guarded<T>(read:()=>Promise<T>):Promise<T>{try{return await read();}catch(error){clearBitgetAccountCache(this.client);throw error;}}
  private market(symbol:string):any {
    const m=this.client.market(symbol);
    if(!isEligibleMarket(m)||numeric(m.contractSize)!==1)throw new Error('bitget: UTA supports base-coin USDT linear perpetuals only');
    return m;
  }
  private marketById(id:string):any {
    const matches:any[]=Object.values(this.client.markets).filter((m:any)=>m.id===id&&m.swap&&m.linear&&m.quote==='USDT'&&m.settle==='USDT'&&numeric(m.contractSize)===1);
    if(matches.length!==1)throw new Error('bitget: cannot identify UTA USDT perpetual market');
    return matches[0];
  }
  private async settingsRead(){
    try{return await readVerifiedBitgetSettings(this.client);}
    catch(error){
      if(error instanceof Error&&error.message==='bitget: account mode is unknown or transitioning; retry once the upgrade is complete')
        throw new Error('bitget: verified unified account required; account transition or hybrid mode cannot use UTA execution');
      throw error;
    }
  }
  private async settings():Promise<any>{return (await this.settingsRead()).data;}
  private async assets():Promise<any>{
    invalidateBitgetTradingModes(this.client);
    return this.guarded(async()=>bitgetUtaData(await this.client.privateUtaGetV3AccountAssets({})));
  }
  private async positions(symbol?:string):Promise<any[]>{
    const data=bitgetUtaData(await this.client.privateUtaGetV3PositionCurrentPosition({category:CATEGORY,...(symbol?{symbol:this.market(symbol).id}:{})}));
    // This endpoint also returns an explicit null list for an empty account. Missing/malformed lists still fail.
    return data?.list===null?[]:list(data);
  }
  private balances(data:any){
    if(!Array.isArray(data?.assets)||data.assets.some((a:any)=>typeof a?.coin!=='string'||!a.coin))throw new Error('bitget: UTA asset list unavailable');
    const coins=new Set<string>();
    for(const a of data.assets){if(coins.has(a.coin))throw new Error('bitget: duplicate UTA asset');coins.add(a.coin);}
    // The official assets endpoint omits zero-balance coins. A present malformed coin is never zero-filled.
    const usdt=data.assets.find((a:any)=>a.coin==='USDT');
    const available=usdt?numeric(usdt.available):0,coinEquity=usdt?numeric(usdt.equity):0;
    const equityUsd=numeric(data.accountEquity),effective=numeric(data.effEquity),initial=numeric(data.imr);
    if(![available,coinEquity,equityUsd,effective,initial].every(Number.isFinite)||initial<0)throw new Error('bitget: incomplete UTA balances');
    return {available,coinEquity,equityUsd,marginAvailable:Math.max(0,effective-initial),usdt,assets:data.assets as any[]};
  }
  private assertBudgetAssets(_settings:any,balance:ReturnType<BitgetUta['balances']>):void {
    for(const a of balance.assets){
      if(numeric(a.debt)!==0)throw new Error('bitget: UTA borrowed or unverified assets are unsupported for execution');
      if(!Number.isFinite(numeric(a.equity))||numeric(a.equity)<0)throw new Error('bitget: UTA negative or unverified asset equity is unsupported for execution');
    }
  }
  private executionWarnings(settings:any,balance:ReturnType<BitgetUta['balances']>):string[] {
    const warnings:string[]=[];
    if(settings.accountLevel==='advanced')warnings.push('当前为高级统一账户，暂不支持本策略执行；余额可读取');
    else if(settings.accountLevel==='delta')warnings.push('当前为 Delta 统一账户，暂不支持本策略执行；余额可读取');
    else if(!['basic','isolated'].includes(settings.accountLevel))warnings.push('无法确认统一账户的保证金模式，暂不支持本策略执行；余额可读取');
    if(settings.deltaSwitch==='yes'&&settings.accountLevel!=='delta')warnings.push('统一账户已启用 Delta 模式，暂不支持本策略执行；余额可读取');
    if(!['one_way_mode','hedge_mode'].includes(settings.holdMode))warnings.push('无法确认统一账户的持仓模式，暂不支持本策略执行；余额可读取');
    if(balance.assets.some(a=>Number.isFinite(numeric(a.debt))&&numeric(a.debt)!==0))warnings.push('统一账户存在非零负债，本策略暂不支持借贷资产执行；余额可读取');
    if(balance.assets.some(a=>!Number.isFinite(numeric(a.debt))))warnings.push('统一账户负债字段缺失或无法确认，暂不支持本策略执行；余额可读取');
    if(balance.assets.some(a=>Number.isFinite(numeric(a.equity))&&numeric(a.equity)<0))warnings.push('统一账户存在负权益资产，暂不支持本策略执行；余额可读取');
    if(balance.assets.some(a=>!Number.isFinite(numeric(a.equity))))warnings.push('无法确认统一账户的资产权益，暂不支持本策略执行；余额可读取');
    return warnings;
  }
  private symbolConfig(settings:any,symbol:string,allowMissing=false):SymbolConfig|undefined {
    const m=this.market(symbol);
    if(!Array.isArray(settings.symbolConfigList))throw new Error('bitget: UTA symbol margin/leverage configuration unavailable');
    const matches=settings.symbolConfigList.filter((c:any)=>c.category===CATEGORY&&c.symbol===m.id);
    if(matches.length===0&&allowMissing)return undefined;
    const invalid=()=>new Error('bitget: UTA symbol margin/leverage must be explicitly configured');
    if(!matches.length||matches.length>2||!['crossed','isolated'].includes(matches[0].marginMode))throw invalid();
    const marginMode=matches[0].marginMode;
    if(settings.accountLevel==='isolated'&&marginMode!=='isolated')throw new Error('bitget: UTA isolated account has incompatible symbol margin mode');
    let longLeverage:number,shortLeverage:number;
    if(matches.length===1){
      const c=matches[0];
      if(c.posSide!==undefined&&c.posSide!=='')throw invalid();
      // UTA crossed settings can return a real common leverage alongside null optional
      // long/short fields. Null is absent here, not an override of the persisted leverage.
      // If no valid common value exists, numeric still fails and preparation cannot guess it.
      longLeverage=numeric(c.longLeverage??c.leverage);
      shortLeverage=numeric(c.shortLeverage??c.leverage);
    }else{
      if(settings.holdMode!=='hedge_mode'||marginMode!=='isolated'||matches.some((c:any)=>c.marginMode!==marginMode))throw invalid();
      const long=matches.filter((c:any)=>c.posSide==='long'),short=matches.filter((c:any)=>c.posSide==='short');
      if(long.length!==1||short.length!==1)throw invalid();
      longLeverage=numeric(long[0].leverage);shortLeverage=numeric(short[0].leverage);
    }
    if(!(longLeverage>0&&shortLeverage>0&&Number.isFinite(longLeverage)&&Number.isFinite(shortLeverage)))throw invalid();
    if((settings.holdMode==='one_way_mode'||marginMode==='crossed')&&longLeverage!==shortLeverage)throw invalid();
    return {marginMode,holdMode:settings.holdMode,accountLevel:settings.accountLevel,longLeverage,shortLeverage};
  }
  private budget(settings:any,balance:ReturnType<BitgetUta['balances']>):number {
    return Math.max(0,settings.accountLevel==='isolated'?balance.available:Math.min(balance.available,balance.marginAvailable));
  }
  private position(raw:any,settings:any):AccountPosition|null {
    const quantity=numeric(raw?.total);
    if(!Number.isFinite(quantity)||quantity<0)throw new Error('bitget: invalid UTA position quantity');
    if(quantity===0)return null;
    const m=this.marketById(raw.symbol),config=this.symbolConfig(settings,m.symbol)!;
    if(raw.category!==CATEGORY||raw.marginCoin!=='USDT'||raw.holdMode!==settings.holdMode||raw.marginMode!==config.marginMode||!['long','short'].includes(raw.posSide))throw new Error('bitget: UTA position mode or currency mismatch');
    const markPrice=numeric(raw.markPrice),leverage=numeric(raw.leverage),liquidationPrice=numeric(raw.liquidationPrice);
    if(!(markPrice>0&&leverage>0&&Number.isFinite(liquidationPrice)))throw new Error('bitget: incomplete UTA position risk data');
    return {base:m.base,symbol:m.symbol,side:raw.posSide,quantity,markPrice,leverage,marginMode:raw.marginMode,
      liquidationPrice:Math.max(0,liquidationPrice),liquidationStatus:liquidationPrice>0?'price':'not_liquidatable',
      ...(liquidationPrice<=0?{liquidationReason:'交易所当前返回无强平价；全仓风险随账户变化'}:{}),
      ...positionMetrics(raw.avgPrice,raw.unrealisedPnl,raw.totalFunding,Number.isFinite(numeric(raw.openFeeTotal))&&Number.isFinite(numeric(raw.closeFeeTotal))?numeric(raw.openFeeTotal)+numeric(raw.closeFeeTotal):undefined,raw.curRealisedPnl),
      ...positionTimestamps(raw.createdTime,raw.updatedTime)};
  }
  async fetchAccountOverview():Promise<AccountOverview>{
    return this.guarded(()=>this.fetchAccountOverviewRead());
  }
  private async fetchAccountOverviewRead():Promise<AccountOverview>{
    const [settings,assets,rows]=await Promise.all([this.settings(),this.assets(),this.positions()]);
    validSettings(settings);
    const b=this.balances(assets),warnings=this.executionWarnings(settings,b);
    let positionsCompatible=true;
    let positionCount=0;
    for(const row of rows){
      const quantity=numeric(row?.total);
      if(!Number.isFinite(quantity)||quantity<0)throw new Error('bitget: invalid UTA overview position quantity');
      if(quantity>0){
        positionCount++;
        if(row.category!==CATEGORY||row.marginCoin!=='USDT'||row.holdMode!==settings.holdMode||!['crossed','isolated'].includes(row.marginMode)||settings.accountLevel==='isolated'&&row.marginMode!=='isolated')positionsCompatible=false;
      }
    }
    if(!positionsCompatible)warnings.push('统一账户已有持仓的产品、保证金币种或持仓模式不符合本策略要求；当前为只读概览');
    const executionSupported=warnings.length===0;
    const accountMode=['isolated','basic','advanced','delta'].includes(settings.accountLevel)?settings.accountLevel:undefined;
    const positionMode=['one_way_mode','hedge_mode'].includes(settings.holdMode)?settings.holdMode:undefined;
    return {freeUsd:this.budget(settings,b),equityUsd:b.equityUsd,positionCount,balanceScope:'unified_usdt',accountType:'unified',
      accountMode,positionMode,executionSupported,usdtAvailableUsd:b.available,marginAvailableUsd:b.marginAvailable,...(warnings.length?{warnings}:{})};
  }
  async fetchAccount():Promise<AccountState>{
    return this.guarded(()=>this.fetchAccountRead());
  }
  private async fetchAccountRead():Promise<AccountState>{
    const reads=await Promise.allSettled([this.settings(),this.assets(),this.positions()]);
    for(const read of reads)if(read.status==='rejected')throw read.reason;
    assertExchangeRequestActive(this.client,'bitget');
    const [settings,assets,rows]=reads.map(read=>(read as PromiseFulfilledResult<any>).value) as [any,any,any[]];
    assertAccountMode(settings);const b=this.balances(assets);this.assertBudgetAssets(settings,b);
    const positions=rows.map(row=>this.position(row,settings)).filter((p):p is AccountPosition=>p!==null),symbols=new Set<string>();
    for(const p of positions){
      const key=settings.holdMode==='hedge_mode'?`${p.symbol}:${p.side}`:p.symbol;
      if(symbols.has(key))throw new Error('bitget: duplicate UTA position for holding mode');symbols.add(key);
    }
    return {freeUsd:this.budget(settings,b),equityUsd:b.equityUsd,positions};
  }
  async assertTradingMode(symbol:string,force=false):Promise<SymbolConfig>{
    this.market(symbol);
    if(force)clearBitgetAccountCache(this.client);
    const key=`unified:${symbol}:${this.newSymbolMarginMode}:${this.desiredMarginMode??'legacy'}`,cached=cachedBitgetTradingMode<SymbolConfig>(this.client,key);
    if(cached)return cached;
    return this.guarded(async()=>{
      const requestedAt=Date.now(),reads=[this.settingsRead(),this.assets()] as const;
      const version=bitgetTradingModeVersion(this.client),[read,assets]=await Promise.all(reads),settings=read.data;
      assertAccountMode(settings);const b=this.balances(assets);this.assertBudgetAssets(settings,b);
      const config=this.symbolConfig(settings,symbol)!;
      rememberBitgetTradingMode(this.client,key,config,Math.min(requestedAt,read.requestedAt),version);
      return config;
    });
  }
  private async inspectPreparation(symbol:string,leverage:number){
    if(!Number.isFinite(leverage)||leverage<1)throw new Error('bitget: invalid UTA leverage');
    const [settings,assets]=await Promise.all([this.settings(),this.assets()]);
    assertAccountMode(settings);this.assertBudgetAssets(settings,this.balances(assets));
    const config=this.symbolConfig(settings,symbol,true),m=this.market(symbol);
    const marginMode=this.desiredMarginMode??config?.marginMode??this.newSymbolMarginMode;
    if(!['crossed','isolated'].includes(marginMode))throw new Error('bitget: invalid UTA new symbol margin preference');
    if(settings.accountLevel==='isolated'&&marginMode!=='isolated')throw new Error('bitget: UTA isolated account cannot initialize crossed symbol');
    const [positions,open]=await Promise.all([this.positions(symbol),this.client.privateUtaGetV3TradeUnfilledOrders({category:CATEGORY,symbol:m.id,limit:'1'}).then(bitgetUtaData).then(list)]);
    if(positions.some(p=>!Number.isFinite(numeric(p.total))||numeric(p.total)!==0)||open.length)throw new Error('bitget: existing UTA position or pending order; entry refused');
    if(config&&config.marginMode!==marginMode){
      // Margin transitions may not bypass dormant trigger/strategy orders on the same contract.
      const types=['tpsl','trigger','oco','trailing_stop','iceberg','twap'];
      const strategies=await Promise.all(types.map(type=>this.client.privateUtaGetV3TradeUnfilledStrategyOrders({category:CATEGORY,type})));
      for(const response of strategies){
        const rows=bitgetUtaData(response);
        if(!Array.isArray(rows)||rows.some(row=>typeof row?.symbol!=='string'||row.category!==CATEGORY))throw new Error('bitget: active strategy order check unavailable');
        if(rows.some(row=>row.symbol===m.id))throw new Error('bitget: existing UTA position or pending order; entry refused');
      }
    }
    if(!config||config.marginMode!==marginMode){
      // The preview GET uses "cross"; the settings/order POSTs use "crossed". It proves this proposed setup is
      // accepted for preview only, never that leverage or margin settings have already been persisted.
      const preview=bitgetUtaData(await this.client.privateUtaGetV3AccountPreSetLeverage({category:CATEGORY,symbol:m.id,
        marginMode:marginMode==='crossed'?'cross':'isolated',leverage:String(leverage)}));
      if(!(numeric(preview?.requiredMargin)>=0&&Number.isFinite(numeric(preview?.requiredMargin))))throw new Error('bitget: UTA leverage preview margin unavailable');
    }
    return {settings,config,m,marginMode};
  }
  async prepare(symbol:string,leverage:number):Promise<void>{
    return this.guarded(async()=>{
    clearBitgetAccountCache(this.client);
    const {settings,config,m,marginMode}=await this.inspectPreparation(symbol,leverage);
    const params={category:CATEGORY,symbol:m.id,leverage:String(leverage),marginMode};
    clearBitgetAccountCache(this.client);
    if(marginMode==='isolated'){
      for(const posSide of ['long','short'] as const){
        if(config?.marginMode!==marginMode||config?.[posSide==='long'?'longLeverage':'shortLeverage']!==leverage)
          bitgetUtaData(await this.client.privateUtaPostV3AccountSetLeverage({...params,posSide}));
      }
    }else if(config?.marginMode!==marginMode||config?.longLeverage!==leverage||config?.shortLeverage!==leverage)
      bitgetUtaData(await this.client.privateUtaPostV3AccountSetLeverage(params));
    // Even a no-op preparation re-reads actual settings; neither a successful preview nor POST is a readback.
    const checked=await this.assertTradingMode(symbol,true);
    if(checked.marginMode!==marginMode||checked.holdMode!==settings.holdMode||checked.accountLevel!==settings.accountLevel||
      checked.longLeverage!==leverage||checked.shortLeverage!==leverage)throw new Error('bitget: UTA leverage or unchanged margin mode could not be verified');
    });
  }
  async inspectTrading(symbol:string,leverage:number):Promise<void>{
    await this.guarded(()=>this.inspectPreparation(symbol,leverage));
  }
  async place(request:OrderRequest,quantity:number,price:number,canSubmit?:()=>boolean):Promise<string|undefined>{
    return this.guarded(()=>this.placeVerified(request,quantity,price,false,canSubmit));
  }
  /** Dedicated acknowledgement-only Maker closure. Never waits, inspects or cancels here. */
  async placeMakerReduction(request:OrderRequest,quantity:number,price:number,canSubmit?:()=>boolean):Promise<string|undefined>{
    this.assertMakerReduction(request);
    if(!Number.isFinite(quantity)||quantity!==request.quantity||!Number.isFinite(price)||price<=0||
      (request.side==='buy'?price>request.limitPrice:price<request.limitPrice))throw new Error('bitget: Maker reduction quantity or price exceeds original bounds');
    return this.guarded(()=>this.placeVerified(request,quantity,price,true,canSubmit));
  }
  private assertMakerReduction(request:OrderRequest):void {
    assertMakerReductionRequest(request);
    if(request.closePosition||request.base!==this.market(request.symbol).base)
      throw new Error('bitget: dedicated Maker reduction requires a pure post-only reduce-only request');
  }
  private async placeVerified(request:OrderRequest,quantity:number,price:number,makerReduction=false,canSubmit?:()=>boolean):Promise<string|undefined>{
    const signature=JSON.stringify(request),known=submittedIdentities.get(this.client)?.get(request.clientOrderId);
    if(known&&(makerReduction||canSubmit||known.guardedSubmission)){
      if(known.signature!==signature||!!known.makerReduction!==makerReduction)throw new Error('bitget: guarded order client ID conflict');
      if(known.rejection)throw known.rejection;
      return known.id;
    }
    if(!makerReduction&&request.postOnly&&(request.reduceOnly||request.closePosition))throw new Error('bitget: Maker trial can only open a position');
    const config=await this.assertTradingMode(request.symbol),m=this.market(request.symbol);
    // The explicit preference applies only to entries. Closures retain the actual native mode.
    if(!request.reduceOnly&&this.desiredMarginMode&&config.marginMode!==this.desiredMarginMode)throw new Error('bitget: UTA opening margin mode changed after preparation');
    const qty=this.client.amountToPrecision(request.symbol,quantity),limit=this.client.priceToPrecision(request.symbol,price);
    if(!(quantity>0)||numeric(qty)!==quantity||quantity!==request.quantity||!(numeric(limit)>0)||
      (request.side==='buy'?numeric(limit)>request.limitPrice:numeric(limit)<request.limitPrice))throw new Error('bitget: UTA order precision exceeds requested bounds');
    const payload={category:CATEGORY,symbol:m.id,qty,price:limit,
      side:request.side,orderType:'limit',timeInForce:request.postOnly?'post_only':'ioc',marginMode:config.marginMode,pxAmendType:'no',
      clientOid:exchangeClientId('bitget',request.clientOrderId),...(config.holdMode==='hedge_mode'?{posSide:positionSide(request)}:{reduceOnly:request.reduceOnly?'yes':'no'})};
    let identities=submittedIdentities.get(this.client);
    if(!identities){identities=new Map();submittedIdentities.set(this.client,identities);}
    const concurrent=identities.get(request.clientOrderId);
    if(concurrent&&(makerReduction||canSubmit||concurrent.guardedSubmission)){
      if(concurrent.signature!==signature||!!concurrent.makerReduction!==makerReduction)throw new Error('bitget: guarded order client ID conflict');
      if(concurrent.rejection)throw concurrent.rejection;
      return concurrent.id;
    }
    const submitted={signature,marginMode:config.marginMode==='crossed'?'cross' as const:'isolated' as const,
      posSide:config.holdMode==='hedge_mode'?positionSide(request):'net' as const,limitPrice:numeric(limit),
      ...(makerReduction?{makerReduction:true as const}:{}),...(canSubmit?{guardedSubmission:true as const}:{}),
      id:undefined as string|undefined,rejection:undefined as OrderNotSubmittedError|undefined};
    identities.set(request.clientOrderId,submitted);
    try{if(makerReduction)assertMakerReductionPermission(canSubmit);else assertOrderSubmissionPermission(canSubmit);}
    catch(error){submitted.rejection=error as OrderNotSubmittedError;throw error;}
    const data=bitgetUtaData(await this.client.privateUtaPostV3TradePlaceOrder(payload));
    if(makerReduction&&data.clientOid!==undefined&&data.clientOid!==payload.clientOid)throw new Error('bitget: Maker reduction acknowledgement identity mismatch');
    submitted.id=data.orderId?String(data.orderId):undefined;return submitted.id;
  }
  async cancel(symbol:string,id:string):Promise<void>{
    return this.guarded(async()=>{
    this.market(symbol);if(!id)throw new Error('bitget: UTA cancellation requires an exact order ID');
    bitgetUtaData(await this.client.privateUtaPostV3TradeCancelOrder({category:CATEGORY,orderId:id}));
    });
  }
  /** Frozen facts of the actual native submission; no account reads or execution inference. */
  submissionIdentity(request:OrderRequest):{marginMode:'cross'|'isolated';posSide:'net'|'long'|'short';limitPrice:number}|undefined{
    const saved=submittedIdentities.get(this.client)?.get(request.clientOrderId);
    if(!saved||saved.signature!==JSON.stringify(request))return;
    return {marginMode:saved.marginMode,posSide:saved.posSide,limitPrice:saved.limitPrice};
  }
  private normalize(raw:any,request:OrderRequest,prior:OrderResult):OrderResult{
    const m=this.market(request.symbol),reduceOnly=typeof raw?.reduceOnly==='string'?raw.reduceOnly.toUpperCase():'',submitted=this.submissionIdentity(request);
    const expectedPositionSide=positionSide(request),expectedTradeSide=request.reduceOnly?'close':'open';
    // Actual UTA hedge responses also use open_long/open_short/close_long/close_short.
    // Match the full value to the requested position; stripping suffixes would hide a wrong-side fill.
    const tradeSideMatches=raw?.tradeSide===expectedTradeSide||raw?.tradeSide===`${expectedTradeSide}_${expectedPositionSide}`;
    const directionMatches=raw?.holdMode==='hedge_mode'
      ?raw.posSide===expectedPositionSide&&tradeSideMatches&&(!reduceOnly||['YES','NO'].includes(reduceOnly))&&!(reduceOnly==='YES'&&!request.reduceOnly)
      :raw?.holdMode==='one_way_mode'&&['YES','NO'].includes(reduceOnly)&&(reduceOnly==='YES')===request.reduceOnly;
    if(!raw?.orderId||prior.id&&String(raw.orderId)!==prior.id||raw.category!==CATEGORY||raw.symbol!==m.id||raw.clientOid!==exchangeClientId('bitget',request.clientOrderId)||
      raw.side!==request.side||!directionMatches||!['crossed','isolated'].includes(raw.marginMode)||
      submitted!==undefined&&(raw.marginMode!==(submitted.marginMode==='cross'?'crossed':'isolated')||
        (submitted.posSide==='net'?raw.holdMode!=='one_way_mode':raw.holdMode!=='hedge_mode'||raw.posSide!==submitted.posSide)||
        (request.side==='buy'?numeric(raw.price)>submitted.limitPrice:numeric(raw.price)<submitted.limitPrice))||
      !request.reduceOnly&&this.desiredMarginMode&&raw.marginMode!==this.desiredMarginMode||
      raw.orderType!=='limit'||raw.timeInForce!==(request.postOnly?'post_only':'ioc')||!(numeric(raw.price)>0)||
      (request.side==='buy'?numeric(raw.price)>request.limitPrice:numeric(raw.price)<request.limitPrice))throw new Error('bitget: UTA order identity or mode mismatch');
    const quantity=numeric(raw.qty),filledQuantity=numeric(raw.cumExecQty),averagePrice=filledQuantity>0?numeric(raw.avgPrice):0,timestamp=numeric(raw.updatedTime??raw.createdTime);
    if(!Number.isFinite(quantity)||Math.abs(quantity-request.quantity)>Math.max(1e-12,request.quantity*1e-9)||
      !Number.isFinite(filledQuantity)||filledQuantity<prior.filledQuantity||filledQuantity<0||filledQuantity>request.quantity*(1+1e-9)||
      !(timestamp>0)||filledQuantity>0&&!(averagePrice>0))throw new Error('bitget: inconsistent UTA cumulative execution');
    let feeUsd=0,feesKnown=Array.isArray(raw.feeDetail)&&(filledQuantity===0||raw.feeDetail.length>0);
    for(const fee of Array.isArray(raw.feeDetail)?raw.feeDetail:[]){
      // A zero-fill IOC cancellation returns empty strings, not a charged fee.
      if(filledQuantity===0&&(fee?.feeCoin==null||fee.feeCoin==='')&&(fee?.fee==null||fee.fee===''))continue;
      if(fee?.feeCoin!=='USDT'||!Number.isFinite(numeric(fee.fee)))feesKnown=false;
      else feeUsd+=numeric(fee.fee);
    }
    if(!feesKnown)feeUsd=prior.feeUsd;
    const terminal=['filled','cancelled','canceled'].includes(raw.orderStatus);
    return {id:String(raw.orderId),clientOrderId:request.clientOrderId,status:!terminal||!feesKnown?'unknown':
      filledQuantity>=request.quantity*(1-1e-9)?'filled':filledQuantity>0?'partial':'cancelled',filledQuantity,averagePrice,averagePriceVerified:false,feeUsd,timestamp};
  }
  private async executionTotals(raw:any,request:OrderRequest,result:OrderResult,makerReduction=false):Promise<{averagePrice:number;feeUsd:number}>{
    if(result.filledQuantity===0)return {averagePrice:0,feeUsd:0};
    const seen=new Map<string,string>(),cursors=new Set<string>(),expectedSide=positionSide(request),action=request.reduceOnly?'close':'open';
    let cursor:string|undefined,quantity=0,valueUsd=0,feeUsd=0;
    for(let page=0;page<100;page++){
      const data=bitgetUtaData(await this.client.privateUtaGetV3TradeFills({category:CATEGORY,orderId:result.id,limit:'100',...(cursor?{cursor}:{})}));
      const records=list(data);
      for(const trade of records){
        const qty=numeric(trade?.execQty),price=numeric(trade?.execPrice);
        if(typeof trade?.execId!=='string'||!trade.execId||trade.orderId!==result.id||trade.clientOid!==raw.clientOid||
          trade.category!==CATEGORY||trade.symbol!==raw.symbol||trade.side!==request.side||trade.orderType!=='limit'||
          ![action,`${action}_${expectedSide}`].includes(trade.tradeSide)||!Number.isFinite(qty)||qty<=0||!Number.isFinite(price)||price<=0||
          request.side==='buy'&&price>request.limitPrice+Math.max(1e-12,request.limitPrice*1e-12)||
          request.side==='sell'&&price<request.limitPrice-Math.max(1e-12,request.limitPrice*1e-12)||
          makerReduction&&(request.side==='buy'?price>numeric(raw.price)+Math.max(1e-12,request.limitPrice*1e-12):price<numeric(raw.price)-Math.max(1e-12,request.limitPrice*1e-12))||
          makerReduction&&trade.tradeScope!=='maker'||!Array.isArray(trade.feeDetail)||!trade.feeDetail.length)throw new Error('bitget: UTA execution identity, price or fee data incomplete');
        let fees=0;
        for(const fee of trade.feeDetail){
          if(fee?.feeCoin!=='USDT'||!Number.isFinite(numeric(fee.fee)))throw new Error('bitget: UTA execution fees are not verified USDT cash');
          fees+=numeric(fee.fee);
        }
        const signature=JSON.stringify([trade.orderId,trade.clientOid,trade.category,trade.symbol,trade.side,trade.tradeSide,qty,price,fees]);
        const previous=seen.get(trade.execId);
        if(previous!==undefined){if(previous!==signature)throw new Error('bitget: conflicting duplicate UTA execution');continue;}
        seen.set(trade.execId,signature);quantity+=qty;valueUsd+=qty*price;feeUsd+=fees;
      }
      // Order avgPrice (and even cumExecValue) is truncated by Bitget. Only a complete,
      // identity-checked set of executions can replace it. A cursor may remain on a short page.
      if(Math.abs(quantity-result.filledQuantity)<=Math.max(1e-12,result.filledQuantity*1e-9))return {averagePrice:valueUsd/quantity,feeUsd};
      if(quantity>result.filledQuantity*(1+1e-9))throw new Error('bitget: execution quantity exceeds confirmed cumulative fill');
      if(typeof data.cursor!=='string'||!data.cursor||!records.length||cursors.has(data.cursor))
        throw new Error('bitget: UTA execution pages do not cover confirmed fills');
      cursors.add(data.cursor);cursor=data.cursor;
    }
    throw new Error('bitget: UTA execution pagination limit exceeded');
  }
  private async verifiedExecution(raw:any,request:OrderRequest,result:OrderResult):Promise<OrderResult>{
    const totals=await this.executionTotals(raw,request,result);
    return {...result,...totals,averagePriceVerified:true,
      status:result.filledQuantity===0?result.status:!['filled','cancelled','canceled'].includes(raw.orderStatus)?'unknown':
        result.filledQuantity>=request.quantity*(1-1e-9)?'filled':result.filledQuantity>0?'partial':'cancelled'};
  }
  /** GET only. Active partial fills are separate from legacy IOC terminal receipts. */
  async inspectMakerReduction(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<MakerReductionObservation>{
    try{
      this.assertMakerReduction(request);orderId??=prior.id||undefined;
      const raw=bitgetUtaData(await this.client.privateUtaGetV3TradeOrderInfo(orderId?{orderId}:{clientOid:exchangeClientId('bitget',request.clientOrderId)}));
      if(orderId&&raw?.orderId!==orderId)throw new Error('bitget: UTA Maker queried order ID mismatch');
      if(Array.isArray(raw?.feeDetail)&&raw.feeDetail.some((fee:any)=>fee?.feeCoin!=='USDT'&&numeric(fee?.fee)!==0&&
        !(numeric(raw.cumExecQty)===0&&(fee?.feeCoin==null||fee.feeCoin==='')&&(fee?.fee==null||fee.fee===''))))
        throw new Error('bitget: UTA Maker summary reports unsupported fee cash');
      const result=this.normalize(raw,request,prior),activity=['live','new','partially_filled'].includes(raw.orderStatus)?'active' as const:
        ['filled','cancelled','canceled'].includes(raw.orderStatus)?'terminal' as const:undefined;
      if(!activity||raw.orderStatus==='filled'&&Math.abs(result.filledQuantity-request.quantity)>Math.max(1e-12,request.quantity*1e-9))
        throw new Error('bitget: UTA Maker activity contradicts cumulative quantity');
      const totals=await this.executionTotals(raw,request,result,true);
      const observation=verifiedMakerReduction(request,{...result,...totals},activity);
      // https://www.bitget.com/docs/uta/enum#cancelreason
      // This UTA cancellation reason is specific to an immediately marketable PostOnly order.
      if(request.postOnly&&observation.activity==='terminal'&&observation.executionVerified&&
        observation.result.status==='cancelled'&&observation.result.filledQuantity===0&&observation.result.feeUsd===0&&
        result.status==='cancelled'&&result.feeUsd===0&&raw.cancelReason==='post_only_fill_cancel')
        observation.result={...observation.result,rejectionCode:'MAKER_POST_ONLY_WOULD_TAKE',
          rejectionReason:'Bitget UTA PostOnly 委托会立即吃单，交易所已取消；本单确认未成交、未扣费'};
      return observation;
    }catch{
      clearBitgetAccountCache(this.client);return unknownMakerReduction(prior);
    }
  }
  /** Pure GET verification for independent valuation. No cancellation, submission or ledger mutation. */
  async verifyOrderExecution(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<OrderResult>{
    return this.guarded(()=>this.verifyOrderExecutionRead(request,prior,orderId));
  }
  private async verifyOrderExecutionRead(request:OrderRequest,prior:OrderResult,orderId?:string):Promise<OrderResult>{
    orderId??=prior.id||undefined;
    const params=orderId?{orderId}:{clientOid:exchangeClientId('bitget',request.clientOrderId)};
    const raw=bitgetUtaData(await this.client.privateUtaGetV3TradeOrderInfo(params));
    if(orderId&&raw?.orderId!==orderId)throw new Error('bitget: UTA queried order ID mismatch');
    return this.verifiedExecution(raw,request,this.normalize(raw,request,prior));
  }
  /** Pure observation for background/account recovery; never cancel a live order. */
  async inspectOrder(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<OrderResult>{
    let confirmed=prior;
    try{
      orderId??=prior.id||undefined;
      const params=orderId?{orderId}:{clientOid:exchangeClientId('bitget',request.clientOrderId)};
      const raw=bitgetUtaData(await this.client.privateUtaGetV3TradeOrderInfo(params));
      if(orderId&&raw?.orderId!==orderId)throw new Error('bitget: UTA queried order ID mismatch');
      const result=this.normalize(raw,request,prior);confirmed=result;
      return await this.verifiedExecution(raw,request,result);
    }catch{clearBitgetAccountCache(this.client);return {...confirmed,...(request.postOnly?{status:'unknown' as const}:{}),averagePriceVerified:false};}
  }
  /** Complete GET-only normal + strategy observation; default strategy type only covers TPSL. */
  async fetchOpenOrders(symbol:string):Promise<AccountOpenOrder[]>{
    return this.guarded(()=>this.fetchOpenOrdersRead(symbol));
  }
  private async fetchOpenOrdersRead(symbol:string):Promise<AccountOpenOrder[]>{
    const m=this.market(symbol),all:AccountOpenOrder[]=[],ids=new Map<string,string>(),cursors=new Set<string>();
    const add=(row:any,kind:'regular'|'conditional')=>{
      if(typeof row?.symbol!=='string'||row.category!==CATEGORY)throw new Error('bitget: ambiguous active order identity');
      if(row.symbol!==m.id)return; // Strategy endpoint returns the whole product category.
      const quantity=kind==='conditional'&&(row.qty===undefined||row.qty===null||row.qty==='')?0:numeric(row.qty);
      const filled=kind==='regular'?numeric(row.cumExecQty):0;
      if(typeof row.orderId!=='string'||!row.orderId||!Number.isFinite(quantity)||quantity<0||!Number.isFinite(filled)||filled<0||filled>quantity||
        kind==='regular'&&(!['buy','sell'].includes(row.side)||!['live','new','partially_filled'].includes(row.orderStatus))||
        kind==='conditional'&&row.status!==undefined&&!['pending','submitting'].includes(row.status))
        throw new Error('bitget: invalid active order observation');
      const result:AccountOpenOrder={id:row.orderId,base:m.base,symbol:m.symbol,quantity,remainingQuantity:quantity-filled,kind,
        ...(typeof row.clientOid==='string'&&row.clientOid?{clientOrderId:row.clientOid}:{}),
        ...(['buy','sell'].includes(row.side)?{side:row.side}:{}),
        ...(['YES','NO'].includes(row.reduceOnly)?{reduceOnly:row.reduceOnly==='YES'}:{})};
      const key=`${kind}:${row.orderId}`,signature=JSON.stringify(result),prior=ids.get(key);
      if(prior){if(prior!==signature)throw new Error('bitget: conflicting active order observation');return;}
      ids.set(key,signature);all.push(result);
    };
    let cursor:string|undefined,complete=false;
    for(let page=0;page<100;page++){
      assertExchangeRequestActive(this.client,'bitget');
      const data=bitgetUtaData(await this.client.privateUtaGetV3TradeUnfilledOrders({category:CATEGORY,symbol:m.id,limit:'100',...(cursor?{cursor}:{})}));
      assertExchangeRequestActive(this.client,'bitget');
      const records=list(data);records.forEach(row=>add(row,'regular'));
      if(data.cursor===null||data.cursor===''){complete=true;break;}
      if(typeof data.cursor!=='string'||!records.length||cursors.has(data.cursor))throw new Error('bitget: active order pagination did not advance');
      cursors.add(data.cursor);cursor=data.cursor;
    }
    if(!complete)throw new Error('bitget: active order pagination limit exceeded');
    const types=['tpsl','trigger','oco','trailing_stop','iceberg','twap'];
    assertExchangeRequestActive(this.client,'bitget');
    const strategies=await Promise.allSettled(types.map(type=>this.client.privateUtaGetV3TradeUnfilledStrategyOrders({category:CATEGORY,type})));
    for(const strategy of strategies)if(strategy.status==='rejected')throw strategy.reason;
    assertExchangeRequestActive(this.client,'bitget');
    for(const strategy of strategies){
      const response=(strategy as PromiseFulfilledResult<any>).value;
      const rows=bitgetUtaData(response);
      if(!Array.isArray(rows))throw new Error('bitget: incomplete active strategy order list');
      rows.forEach(row=>add(row,'conditional'));
    }
    return all;
  }
  async reconcile(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<OrderResult>{
    let confirmed=prior;
    try{
      orderId??=prior.id||undefined;
      const params=orderId?{orderId}:{clientOid:exchangeClientId('bitget',request.clientOrderId)};
      let raw=bitgetUtaData(await this.client.privateUtaGetV3TradeOrderInfo(params));
      if(orderId&&raw?.orderId!==orderId)throw new Error('bitget: UTA queried order ID mismatch');
      let result=this.normalize(raw,request,prior);confirmed=result;
      if(result.status==='unknown'&&['live','new','partially_filled'].includes(raw.orderStatus)){
        await this.cancel(request.symbol,result.id);
        raw=bitgetUtaData(await this.client.privateUtaGetV3TradeOrderInfo({orderId:result.id}));
        if(raw?.orderId!==result.id)throw new Error('bitget: UTA cancellation readback order ID mismatch');
        result=this.normalize(raw,request,result);
      }
      return await this.verifiedExecution(raw,request,result);
    }catch{clearBitgetAccountCache(this.client);return {...confirmed,...(request.postOnly?{status:'unknown' as const}:{}),averagePriceVerified:false};}
  }
  async fetchFundingPayments(since:number,until=Date.now()):Promise<FundingPayment[]>{
    return this.guarded(()=>this.fetchFundingPaymentsRead(since,until));
  }
  private async fetchFundingPaymentsRead(since:number,until:number):Promise<FundingPayment[]>{
    if(!Number.isFinite(since)||!Number.isFinite(until)||since<0||until<since||until-since>90*DAY||since<Date.now()-90*DAY)throw new Error('bitget: UTA funding reconciliation requires a valid window within the latest 90 days');
    const payments=new Map<string,FundingPayment>();let pages=0;
    for(let start=since;start<=until;start+=30*DAY){
      const end=Math.min(until,start+30*DAY-1),seen=new Set<string>();let cursor:string|undefined;
      for(;;){
        assertExchangeRequestActive(this.client,'bitget');
        if(++pages>200)throw new Error('bitget: UTA funding page limit reached; narrow reconciliation window');
        const response=await this.client.privateUtaGetV3AccountFinancialRecords({category:CATEGORY,coin:'USDT',
          startTime:String(start),endTime:String(end),limit:'100',...(cursor?{cursor}:{})});
        assertExchangeRequestActive(this.client,'bitget');
        const data=bitgetUtaData(response);
        // This endpoint returns an explicit null list plus null/empty cursor for an empty window. A missing list,
        // malformed list or a null list claiming another page remains an error, rather than a zero-filled ledger.
        const rows=data?.list===null&&(data.cursor===null||data.cursor==='')?[]:list(data);
        for(const raw of rows){
          if(!FUNDING_TYPES.has(raw.type)||raw.coin!=='USDT'||raw.category!==CATEGORY)continue;
          const amountUsd=numeric(raw.amount),timestamp=numeric(raw.ts);
          if(!raw.id||!Number.isFinite(amountUsd)||!(timestamp>0)||numeric(raw.fee)!==0)throw new Error('bitget: invalid UTA funding invoice');
          if((raw.type.startsWith('MARGIN_')||raw.type.startsWith('FIXED_'))&&amountUsd===0&&numeric(raw.positionAmount)!==0&&raw.positionAmount!==undefined)throw new Error('bitget: isolated UTA funding position cash flow requires manual reconciliation');
          if(raw.type.endsWith('_IN')&&amountUsd<0||raw.type.endsWith('_OUT')&&amountUsd>0)throw new Error('bitget: UTA funding invoice direction mismatch');
          if(timestamp<since||timestamp>until)continue;
          const m=this.marketById(raw.symbol),id=`bitget:uta:${raw.id}`,payment={id,timestamp,base:m.base,symbol:m.symbol,amountUsd};
          const old=payments.get(id);if(old&&(old.timestamp!==timestamp||old.amountUsd!==amountUsd||old.base!==m.base||old.symbol!==m.symbol))throw new Error('bitget: conflicting duplicate UTA funding invoice');
          payments.set(id,payment);
        }
        const next=typeof data.cursor==='string'?data.cursor:'';
        if(!next){if(rows.length>=100)throw new Error('bitget: full UTA funding page missing cursor');break;}
        if(rows.length===0||seen.has(next))throw new Error('bitget: UTA funding cursor did not advance');
        seen.add(next);cursor=next;
      }
    }
    assertExchangeRequestActive(this.client,'bitget');
    return [...payments.values()].sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id));
  }
}
