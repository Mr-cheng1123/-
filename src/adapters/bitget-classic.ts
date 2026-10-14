import { positionMetrics, positionTimestamps } from './position-metrics.js';
import {assertExchangeRequestActive} from './network.js';
import type { AccountOpenOrder, AccountOverview, AccountPosition, AccountState, MakerReductionObservation, OrderRequest, OrderResult } from '../shared/types.js';
import { exchangeClientId, isEligibleMarket, number, unknownOrder } from './normalization.js';
import {bitgetTradingModeVersion,cachedBitgetTradingMode,clearBitgetAccountCache,invalidateBitgetTradingModes,rememberBitgetTradingMode} from './bitget-account.js';
import {assertMakerReductionPermission,assertMakerReductionRequest,unknownMakerReduction,verifiedMakerReduction} from './maker-reduction-observation.js';
import {OrderNotSubmittedError} from './order-rejection.js';
import {assertOrderSubmissionPermission} from './order-submission-permission.js';

const PRODUCT='USDT-FUTURES';
const submittedIdentities=new WeakMap<object,Map<string,{signature:string;marginMode:'cross'|'isolated';posSide:'net';limitPrice:number;makerReduction?:true;guardedSubmission?:true;id?:string;rejection?:OrderNotSubmittedError}>>();
type MarginMode='crossed'|'isolated';
/** Only classic v2 endpoints. Never probe, switch to, or silently route through UTA. */
export function bitgetData(response:any):any {
  if(response?.code!=='00000'||response.data===undefined||response.data===null)throw new Error('bitget: classic USDT futures response unavailable; check account type and permissions');
  return response.data;
}
function assertSingleAsset(raw:any){
  if(raw.marginCoin!=='USDT'||raw.assetMode!=='single')throw new Error('bitget: classic single-asset USDT futures account required; UTA and multi-assets are unsupported');
}
function assertModes(raw:any){
  assertSingleAsset(raw);
  if(raw.posMode!=='one_way_mode')throw new Error('bitget: configure one-way position mode before trading');
  if(!['crossed','isolated'].includes(raw.marginMode))throw new Error('bitget: classic margin mode must be verified');
}
function leverages(raw:any):[number,number]{
  return raw.marginMode==='crossed'?[number(raw.crossedMarginLeverage),number(raw.crossedMarginLeverage)]:[number(raw.isolatedLongLever),number(raw.isolatedShortLever)];
}
function overviewNumber(value:unknown):number {
  return typeof value==='number'||typeof value==='string'&&value.trim()!==''?number(value):NaN;
}
export class BitgetClassic {
  constructor(private client:any,private readonly spotDeadlineMs=5000,private readonly newSymbolMarginMode:MarginMode='isolated',private readonly desiredMarginMode?:MarginMode){
    if(!Number.isFinite(spotDeadlineMs)||spotDeadlineMs<=0)throw new Error('bitget: invalid spot overview deadline');
  }
  private async guarded<T>(read:()=>Promise<T>):Promise<T>{try{return await read();}catch(error){clearBitgetAccountCache(this.client);throw error;}}
  private spotAssets():Promise<any>{
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('bitget: spot overview timed out')),this.spotDeadlineMs);
      // Both handlers remain attached after the deadline: late replies are ignored and late failures are consumed.
      void Promise.resolve().then(()=>this.client.privateSpotGetV2SpotAccountAssets({coin:'USDT'})).then(bitgetData)
        .then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
    });
  }
  private market(symbol:string):any {
    const m=this.client.market(symbol);
    if(!isEligibleMarket(m)||number(m.contractSize)!==1)throw new Error('bitget: only classic linear USDT perpetuals sized in base coins are supported');
    return m;
  }
  private params(symbol:string){return {symbol:this.market(symbol).id,productType:PRODUCT,marginCoin:'USDT'};}
  private position(raw:any):AccountPosition|null{
    const quantity=number(raw.total);
    if(!Number.isFinite(quantity)||quantity<0)throw new Error('bitget: invalid position quantity');
    if(quantity===0)return null;
    const matches:any[]=Object.values(this.client.markets).filter((m:any)=>m.id===raw.symbol&&isEligibleMarket(m)&&number(m.contractSize)===1);
    if(matches.length!==1)throw new Error('bitget: cannot identify classic position market');
    const m=this.market(matches[0].symbol),markPrice=number(raw.markPrice),leverage=number(raw.leverage),liquidationPrice=number(raw.liquidationPrice);
    if(raw.marginCoin!=='USDT'||raw.posMode!=='one_way_mode'||!['crossed','isolated'].includes(raw.marginMode)||!['long','short'].includes(raw.holdSide))throw new Error('bitget: position must use single-direction verified USDT margin');
    if(!(markPrice>0&&leverage>0&&Number.isFinite(liquidationPrice)))throw new Error('bitget: incomplete position risk data');
    // Classic totalFee is funding (not trading fee). Bitget explicitly documents the initial
    // empty string as no funding charged; omitted/malformed fields remain unknown.
    const funding=raw.totalFee===''?0:overviewNumber(raw.totalFee),fee=overviewNumber(raw.deductedFee);
    return {base:m.base,symbol:m.symbol,side:raw.holdSide,quantity,markPrice,leverage,marginMode:raw.marginMode,
      liquidationPrice:Math.max(0,liquidationPrice),liquidationStatus:liquidationPrice>0?'price':'not_liquidatable',
      ...(liquidationPrice<=0?{liquidationReason:'交易所当前返回无强平价；风险随保证金变化'}:{}),
      ...positionMetrics(raw.openPriceAvg,raw.unrealizedPL,funding,Number.isFinite(fee)?-fee:undefined),
      ...positionTimestamps(raw.cTime,raw.uTime)};
  }
  async fetchAccountOverview():Promise<AccountOverview>{
    invalidateBitgetTradingModes(this.client);
    return this.guarded(()=>this.fetchAccountOverviewRead());
  }
  private async fetchAccountOverviewRead():Promise<AccountOverview>{
    // These are independent GETs. A spot permission/network failure must not erase valid futures balances.
    const [accountsResult,positionsResult,spotResult]=await Promise.allSettled([
      Promise.resolve().then(()=>this.client.privateMixGetV2MixAccountAccounts({productType:PRODUCT})).then(bitgetData),
      Promise.resolve().then(()=>this.client.privateMixGetV2MixPositionAllPosition({productType:PRODUCT,marginCoin:'USDT'})).then(bitgetData),
      this.spotAssets(),
    ]);
    if(accountsResult.status==='rejected')throw accountsResult.reason;
    if(positionsResult.status==='rejected')throw positionsResult.reason;
    const accounts=accountsResult.value,rows=positionsResult.value;
    if(!Array.isArray(accounts)||!Array.isArray(rows))throw new Error('bitget: classic account/position schema unavailable');
    const selected=accounts.filter((a:any)=>a?.marginCoin==='USDT');
    if(selected.length!==1)throw new Error('bitget: USDT futures balance unavailable');
    const account=selected[0],freeUsd=overviewNumber(account.available),equityUsd=overviewNumber(account.accountEquity);
    if(![freeUsd,equityUsd].every(Number.isFinite))throw new Error('bitget: incomplete USDT futures balance');
    const warnings:string[]=[];
    if(account.assetMode!=='single')warnings.push(account.assetMode==='union'
      ?'当前 Classic 合约账户使用多资产保证金，本策略暂不支持此交易设置'
      :'合约账户的单资产保证金设置尚未确认');
    let positionCount=0,modeIncompatible=(account.posMode!==undefined&&account.posMode!=='one_way_mode')||
      (account.marginMode!==undefined&&!['crossed','isolated'].includes(account.marginMode));
    for(const row of rows){
      const quantity=overviewNumber(row?.total);
      if(!Number.isFinite(quantity)||quantity<0)throw new Error('bitget: invalid overview position quantity');
      if(quantity>0){
        positionCount++;
        if(row.marginCoin!=='USDT'||row.posMode!=='one_way_mode'||!['crossed','isolated'].includes(row.marginMode))modeIncompatible=true;
      }
    }
    if(modeIncompatible)warnings.push('已有账户或持仓设置不符合单向 USDT 保证金要求；余额可读取，实盘交易仍受设置检查限制');
    const result:AccountOverview={freeUsd,equityUsd,positionCount,balanceScope:'usdt_futures',spotStatus:'unavailable'};
    const isolated=overviewNumber(account.isolatedMaxAvailable);
    if(Number.isFinite(isolated))result.isolatedAvailableUsd=isolated;
    else warnings.push('逐仓可开仓余额暂不可读取');
    if(spotResult.status==='fulfilled'&&Array.isArray(spotResult.value)){
      const spot=spotResult.value,usdt=spot.filter((a:any)=>a?.coin==='USDT');
      const available=spot.length===0?0:usdt.length===1?overviewNumber(usdt[0].available):NaN;
      if(Number.isFinite(available)&&available>=0){result.spotAvailableUsd=available;result.spotStatus='available';}
    }
    if(result.spotStatus==='unavailable')warnings.push('现货 USDT 余额暂不可读取；合约余额仍有效');
    if(warnings.length)result.warnings=warnings;
    return result;
  }
  async fetchAccount():Promise<AccountState>{
    invalidateBitgetTradingModes(this.client);
    return this.guarded(()=>this.fetchAccountRead());
  }
  private async fetchAccountRead():Promise<AccountState>{
    const reads=await Promise.allSettled([
      this.client.privateMixGetV2MixAccountAccounts({productType:PRODUCT}).then(bitgetData),
      this.client.privateMixGetV2MixPositionAllPosition({productType:PRODUCT,marginCoin:'USDT'}).then(bitgetData),
    ]);
    for(const read of reads)if(read.status==='rejected')throw read.reason;
    assertExchangeRequestActive(this.client,'bitget');
    const [accounts,rows]=reads.map(read=>(read as PromiseFulfilledResult<any>).value) as [any[],any[]];
    if(!Array.isArray(accounts)||!Array.isArray(rows))throw new Error('bitget: classic account/position schema unavailable');
    const selected=accounts.filter((a:any)=>a.marginCoin==='USDT');
    if(selected.length!==1)throw new Error('bitget: USDT futures balance unavailable');
    const account=selected[0];assertSingleAsset(account);
    const budgetMode=this.desiredMarginMode??(account.marginMode==='crossed'?'crossed':'isolated');
    const available=overviewNumber(account.available),marginAvailable=overviewNumber(account[budgetMode==='crossed'?'crossedMaxAvailable':'isolatedMaxAvailable']),equityUsd=overviewNumber(account.accountEquity);
    if(![available,marginAvailable,equityUsd].every(Number.isFinite))throw new Error('bitget: incomplete USDT futures balance');
    return {freeUsd:Math.min(available,marginAvailable),equityUsd,positions:rows.map((p:any)=>this.position(p)).filter((p:AccountPosition|null):p is AccountPosition=>p!==null)};
  }
  async assertTradingMode(symbol:string,force=false):Promise<any>{
    const params=this.params(symbol),key=`classic:${symbol}:${this.newSymbolMarginMode}:${this.desiredMarginMode??'legacy'}`;
    if(force)clearBitgetAccountCache(this.client);
    const cached=cachedBitgetTradingMode(this.client,key);if(cached)return cached;
    return this.guarded(async()=>{
      const requestedAt=Date.now(),version=bitgetTradingModeVersion(this.client);
      const data=bitgetData(await this.client.privateMixGetV2MixAccountAccount(params));assertModes(data);
      // The per-symbol account response also contains balances. Only mode/leverage evidence is cached.
      const mode={marginCoin:data.marginCoin,assetMode:data.assetMode,posMode:data.posMode,marginMode:data.marginMode,
        isolatedLongLever:data.isolatedLongLever,isolatedShortLever:data.isolatedShortLever,crossedMarginLeverage:data.crossedMarginLeverage};
      if(leverages(mode).every(value=>Number.isFinite(value)&&value>0))
        rememberBitgetTradingMode(this.client,key,mode,requestedAt,version);
      return mode;
    });
  }
  private async inspectPreparation(symbol:string,leverage:number){
    if(!Number.isFinite(leverage)||leverage<1)throw new Error('bitget: invalid classic leverage');
    const current=await this.assertTradingMode(symbol,true),marginMode=this.desiredMarginMode??'isolated';
    // Old configurations retain the old isolated requirement; only an explicit choice permits switching.
    if(!this.desiredMarginMode&&current.marginMode!=='isolated')throw new Error('bitget: configure isolated margin before trading');
    const params=this.params(symbol);
    const [positions,pending,pendingPartial]=await Promise.all([
      this.client.privateMixGetV2MixPositionSinglePosition(params).then(bitgetData),
      this.client.privateMixGetV2MixOrderOrdersPending({symbol:params.symbol,productType:PRODUCT,status:'live',limit:'1'}).then(bitgetData),
      this.client.privateMixGetV2MixOrderOrdersPending({symbol:params.symbol,productType:PRODUCT,status:'partially_filled',limit:'1'}).then(bitgetData),
    ]);
    if(!Array.isArray(positions)||!Array.isArray(pending.entrustedList)||!Array.isArray(pendingPartial.entrustedList))throw new Error('bitget: existing position/order check unavailable');
    if(positions.some((p:any)=>!Number.isFinite(number(p.total))||number(p.total)!==0||number(p.openDelegateSize,0)>0)||pending.entrustedList.length||pendingPartial.entrustedList.length)throw new Error('bitget: existing position or pending order; entry refused');
    if(current.marginMode!==marginMode){
      const plans=await Promise.all(['normal_plan','profit_loss','track_plan'].map(planType=>this.client.privateMixGetV2MixOrderOrdersPlanPending({symbol:params.symbol,productType:PRODUCT,planType,limit:'1'}).then(bitgetData)));
      if(plans.some(data=>!Array.isArray(data?.entrustedList)))throw new Error('bitget: existing trigger order check unavailable');
      if(plans.some(data=>data.entrustedList.length))throw new Error('bitget: existing position or pending order; entry refused');
    }
    return {current,params,marginMode};
  }
  async inspectTrading(symbol:string,leverage:number):Promise<void>{
    await this.guarded(()=>this.inspectPreparation(symbol,leverage));
  }
  async prepare(symbol:string,leverage:number):Promise<void>{
    return this.guarded(async()=>{
    const {current,params,marginMode}=await this.inspectPreparation(symbol,leverage);
    if(current.marginMode!==marginMode){
      clearBitgetAccountCache(this.client);
      bitgetData(await this.client.privateMixPostV2MixAccountSetMarginMode({...params,marginMode}));
      const switched=await this.assertTradingMode(symbol,true);
      if(switched.marginMode!==marginMode)throw new Error('bitget: classic margin mode change could not be verified');
    }
    // Classic cross and one-way isolated leverage both use the common leverage parameter.
    clearBitgetAccountCache(this.client);
    bitgetData(await this.client.privateMixPostV2MixAccountSetLeverage({...params,leverage:String(leverage)}));
    const checked=await this.assertTradingMode(symbol,true);
    if(checked.marginMode!==marginMode||leverages(checked).some(value=>value!==leverage))throw new Error('bitget: unable to verify requested leverage on both sides');
    });
  }
  async place(request:OrderRequest,quantity:number,price:number,canSubmit?:()=>boolean):Promise<string|undefined>{
    return this.guarded(()=>this.placeVerified(request,quantity,price,false,canSubmit));
  }
  /** Separate, acknowledgement-only entry point. The original IOC/Maker-entry path stays unchanged. */
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
    const mode=await this.assertTradingMode(request.symbol);
    if(!request.reduceOnly&&mode.marginMode!==(this.desiredMarginMode??'isolated'))throw new Error('bitget: classic opening margin mode changed after preparation');
    const size=this.client.amountToPrecision(request.symbol,quantity),limit=this.client.priceToPrecision(request.symbol,price);
    if(makerReduction&&(!(quantity>0)||!Number.isFinite(quantity)||quantity!==request.quantity)||number(size)!==quantity||!(number(limit)>0)||(request.side==='buy'?number(limit)>request.limitPrice:number(limit)<request.limitPrice))throw new Error('bitget: decimal order precision exceeds requested bounds');
    const payload={...this.params(request.symbol),
      marginMode:mode.marginMode,size,price:limit,side:request.side,orderType:'limit',force:request.postOnly?'post_only':'ioc',
      clientOid:exchangeClientId('bitget',request.clientOrderId),reduceOnly:request.reduceOnly?'YES':'NO'};
    let identities=submittedIdentities.get(this.client);
    if(!identities){identities=new Map();submittedIdentities.set(this.client,identities);}
    const concurrent=identities.get(request.clientOrderId);
    if(concurrent&&(makerReduction||canSubmit||concurrent.guardedSubmission)){
      if(concurrent.signature!==signature||!!concurrent.makerReduction!==makerReduction)throw new Error('bitget: guarded order client ID conflict');
      if(concurrent.rejection)throw concurrent.rejection;
      return concurrent.id;
    }
    const submitted={signature,marginMode:mode.marginMode==='crossed'?'cross' as const:'isolated' as const,posSide:'net' as const,limitPrice:number(limit),
      ...(makerReduction?{makerReduction:true as const}:{}),...(canSubmit?{guardedSubmission:true as const}:{}),
      id:undefined as string|undefined,rejection:undefined as OrderNotSubmittedError|undefined};
    identities.set(request.clientOrderId,submitted);
    try{if(makerReduction)assertMakerReductionPermission(canSubmit);else assertOrderSubmissionPermission(canSubmit);}
    catch(error){submitted.rejection=error as OrderNotSubmittedError;throw error;}
    const data=bitgetData(await this.client.privateMixPostV2MixOrderPlaceOrder(payload));
    // Acceptance is not execution. Some reduce-only acknowledgements legitimately have no orderId.
    if(makerReduction&&data.clientOid!==undefined&&data.clientOid!==payload.clientOid)throw new Error('bitget: Maker reduction acknowledgement identity mismatch');
    submitted.id=data.orderId?String(data.orderId):undefined;return submitted.id;
  }
  async cancel(symbol:string,id:string):Promise<void>{
    return this.guarded(async()=>{
    if(!id)throw new Error('bitget: order ID required for cancellation');
    bitgetData(await this.client.privateMixPostV2MixOrderCancelOrder({...this.params(symbol),orderId:id}));
    });
  }
  /** Frozen facts of the actual native submission; no account reads or execution inference. */
  submissionIdentity(request:OrderRequest):{marginMode:'cross'|'isolated';posSide:'net';limitPrice:number}|undefined{
    const saved=submittedIdentities.get(this.client)?.get(request.clientOrderId);
    if(!saved||saved.signature!==JSON.stringify(request))return;
    return {marginMode:saved.marginMode,posSide:saved.posSide,limitPrice:saved.limitPrice};
  }
  /** Only the selected symbol is read. Both live/partial ordinary orders and all trigger families
   * must be complete before the manual-close precheck can establish that no order is active. */
  async fetchOpenOrders(symbol:string):Promise<AccountOpenOrder[]>{
    return this.guarded(async()=>{
      const m=this.market(symbol),all:AccountOpenOrder[]=[],seen=new Map<string,string>();
      const queries=[...(['live','partially_filled'] as const).map(status=>({kind:'regular' as const,status})),
        ...(['normal_plan','profit_loss','track_plan'] as const).map(planType=>({kind:'conditional' as const,planType}))];
      for(const query of queries){
        let idLessThan:string|undefined,complete=false;const cursors=new Set<string>();
        for(let page=0;page<100;page++){
          assertExchangeRequestActive(this.client,'bitget');
          const params={symbol:m.id,productType:PRODUCT,limit:'100',...(idLessThan?{idLessThan}:{}),
            ...(query.kind==='regular'?{status:query.status}:{planType:query.planType})};
          const data=bitgetData(await (query.kind==='regular'?this.client.privateMixGetV2MixOrderOrdersPending(params):
            this.client.privateMixGetV2MixOrderOrdersPlanPending(params)));
          assertExchangeRequestActive(this.client,'bitget');
          if(!Array.isArray(data?.entrustedList))throw new Error('bitget: incomplete classic active order list');
          for(const row of data.entrustedList){
            const quantity=overviewNumber(row?.size),filled=query.kind==='regular'?overviewNumber(row?.baseVolume):0;
            const validPlanType=query.kind==='regular'||(query.planType==='profit_loss'
              ?['profit_loss','profit_plan','loss_plan','moving_plan','pos_profit','pos_loss'].includes(row?.planType):row?.planType===query.planType);
            if(typeof row?.orderId!=='string'||!row.orderId||row.symbol!==m.id||!validPlanType||
              !Number.isFinite(quantity)||quantity<0||!Number.isFinite(filled)||filled<0||filled>quantity||
              query.kind==='regular'&&(!['buy','sell'].includes(row.side)||row.status!==query.status)||
              query.kind==='conditional'&&row.planStatus!=='not_trigger')throw new Error('bitget: invalid classic active order identity or quantity');
            const side=['buy','sell'].includes(row.side)?row.posMode==='hedge_mode'&&row.tradeSide==='close'
              ?row.side==='buy'?'sell' as const:'buy' as const:row.side as 'buy'|'sell':undefined;
            const result:AccountOpenOrder={id:row.orderId,base:m.base,symbol:m.symbol,quantity,remainingQuantity:quantity-filled,kind:query.kind,
              ...(typeof row.clientOid==='string'&&row.clientOid?{clientOrderId:row.clientOid}:{}),...(side?{side}:{}),
              ...(['YES','NO'].includes(row.reduceOnly)?{reduceOnly:row.reduceOnly==='YES'}:{})};
            const key=`${query.kind}:${row.orderId}`,signature=JSON.stringify(result),previous=seen.get(key);
            if(previous!==undefined){if(previous!==signature)throw new Error('bitget: conflicting classic active order observation');continue;}
            seen.set(key,signature);all.push(result);
          }
          if(data.entrustedList.length<100){complete=true;break;}
          if(typeof data.endId!=='string'||!data.endId||cursors.has(data.endId))throw new Error('bitget: classic active order pagination did not advance');
          cursors.add(data.endId);idLessThan=data.endId;
        }
        if(!complete)throw new Error('bitget: classic active order pagination limit exceeded');
      }
      return all;
    });
  }
  private normalize(raw:any,request:OrderRequest,prior:OrderResult,orderId?:string,makerObservation=false):OrderResult{
    const m=this.market(request.symbol),clientId=exchangeClientId('bitget',request.clientOrderId),submitted=this.submissionIdentity(request);
    const expectedId=orderId||prior.id;
    if(!raw.orderId||expectedId&&String(raw.orderId)!==expectedId||prior.id&&String(raw.orderId)!==prior.id||raw.symbol!==m.id||raw.clientOid!==clientId||raw.side!==request.side||raw.marginCoin!=='USDT'||!['YES','NO'].includes(raw.reduceOnly)||
      raw.posMode!=='one_way_mode'||!['crossed','isolated'].includes(raw.marginMode)||
      submitted!==undefined&&(raw.marginMode!==(submitted.marginMode==='cross'?'crossed':'isolated')||
        (request.side==='buy'?overviewNumber(raw.price)>submitted.limitPrice:overviewNumber(raw.price)<submitted.limitPrice))||
      !request.reduceOnly&&raw.marginMode!==(this.desiredMarginMode??'isolated')||(raw.reduceOnly==='YES')!==request.reduceOnly||
      raw.orderType!=='limit'||(request.postOnly?!['post_only','post only'].includes(raw.force):raw.force!=='ioc')||
      !(overviewNumber(raw.price)>0)||(request.side==='buy'?overviewNumber(raw.price)>request.limitPrice:overviewNumber(raw.price)<request.limitPrice))
      throw new Error('bitget: order identity or account mode mismatch');
    const quantity=number(raw.size),filledQuantity=number(raw.baseVolume),fee=number(raw.fee),timestamp=number(raw.uTime??raw.cTime);
    const averagePrice=filledQuantity>0?number(raw.priceAvg):0;
    if(!Number.isFinite(quantity)||Math.abs(quantity-request.quantity)>Math.max(1e-12,request.quantity*1e-9)||
      !Number.isFinite(filledQuantity)||filledQuantity<prior.filledQuantity||filledQuantity<0||filledQuantity>request.quantity*(1+1e-9)||
      !makerObservation&&!Number.isFinite(fee)||!(timestamp>0)||filledQuantity>0&&!(averagePrice>0))throw new Error('bitget: incomplete or inconsistent cumulative fill data');
    if(raw.feeDetail){
      const details=typeof raw.feeDetail==='string'?JSON.parse(raw.feeDetail):raw.feeDetail;
      for(const detail of Object.values(details) as any[])if((detail.feeCoin??detail.feeCoinCode)!=='USDT'&&number(detail.totalFee,0)!==0)throw new Error('bitget: non-USDT discounted order fees require manual reconciliation');
    }
    const terminal=['filled','canceled','cancelled','rejected'].includes(raw.state);
    // A partially filled *open* IOC remains unknown until cancellation is confirmed.
    return {id:String(raw.orderId??prior.id),clientOrderId:request.clientOrderId,
      status:!terminal?'unknown':filledQuantity>=request.quantity*(1-1e-9)?'filled':filledQuantity>0?'partial':'cancelled',
      filledQuantity,averagePrice,feeUsd:makerObservation?prior.feeUsd:-fee,timestamp,...(makerObservation?{averagePriceVerified:false}:{})};
  }
  private async makerExecutionTotals(raw:any,request:OrderRequest,result:OrderResult):Promise<{averagePrice:number;feeUsd:number}>{
    if(result.filledQuantity===0)return {averagePrice:0,feeUsd:0};
    const seen=new Map<string,string>(),cursors=new Set<string>();let idLessThan:string|undefined,quantity=0,valueUsd=0,feeUsd=0;
    for(let page=0;page<100;page++){
      const data=bitgetData(await this.client.privateMixGetV2MixOrderFills({symbol:raw.symbol,productType:PRODUCT,orderId:result.id,limit:'100',...(idLessThan?{idLessThan}:{})}));
      if(!Array.isArray(data.fillList))throw new Error('bitget: incomplete classic Maker execution list');
      for(const trade of data.fillList){
        const qty=overviewNumber(trade?.baseVolume),price=overviewNumber(trade?.price);
        if(typeof trade?.tradeId!=='string'||!trade.tradeId||trade.orderId!==result.id||trade.symbol!==raw.symbol||
          trade.clientOid!==undefined&&trade.clientOid!==raw.clientOid||trade.side!==request.side||trade.posMode!=='one_way_mode'||
          trade.tradeSide!==`${request.side}_single`||trade.marginCoin!==undefined&&trade.marginCoin!=='USDT'||
          !Number.isFinite(qty)||qty<=0||!Number.isFinite(price)||price<=0||
          (request.side==='buy'?price>overviewNumber(raw.price)+Math.max(1e-12,request.limitPrice*1e-12):price<overviewNumber(raw.price)-Math.max(1e-12,request.limitPrice*1e-12))||
          trade.tradeScope!=='maker'||!Array.isArray(trade.feeDetail)||!trade.feeDetail.length)
          throw new Error('bitget: classic Maker execution identity or price incomplete');
        let fee=0;
        for(const detail of trade.feeDetail){
          const paid=overviewNumber(detail?.totalFee),discount=overviewNumber(detail?.totalDeductionFee);
          if(detail?.feeCoin!=='USDT'||!Number.isFinite(paid)||detail.deduction!=='no'||discount!==0)
            throw new Error('bitget: classic Maker fees are not verified USDT cash');
          fee-=paid;
        }
        const signature=JSON.stringify([trade.orderId,trade.symbol,trade.side,trade.posMode,trade.tradeSide,qty,price,fee]);
        const previous=seen.get(trade.tradeId);
        if(previous!==undefined){if(previous!==signature)throw new Error('bitget: conflicting duplicate classic Maker fill');continue;}
        seen.set(trade.tradeId,signature);quantity+=qty;valueUsd+=qty*price;feeUsd+=fee;
      }
      if(Math.abs(quantity-result.filledQuantity)<=Math.max(1e-12,result.filledQuantity*1e-9))return {averagePrice:valueUsd/quantity,feeUsd};
      if(quantity>result.filledQuantity*(1+1e-9))throw new Error('bitget: classic Maker executions exceed observed cumulative fill');
      if(typeof data.endId!=='string'||!data.endId||!data.fillList.length||cursors.has(data.endId))
        throw new Error('bitget: classic Maker execution pages do not cover cumulative fills');
      cursors.add(data.endId);idLessThan=data.endId;
    }
    throw new Error('bitget: classic Maker execution pagination limit exceeded');
  }
  /** GET only. An active Maker is never cancelled and never becomes a legacy terminal receipt. */
  async inspectMakerReduction(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<MakerReductionObservation>{
    try{
      this.assertMakerReduction(request);orderId??=prior.id||undefined;
      const raw=bitgetData(await this.client.privateMixGetV2MixOrderDetail({symbol:this.market(request.symbol).id,productType:PRODUCT,
        ...(orderId?{orderId}:{clientOid:exchangeClientId('bitget',request.clientOrderId)})}));
      const result=this.normalize(raw,request,prior,orderId,true);
      const activity=['live','partially_filled'].includes(raw.state)?'active' as const:['filled','canceled','cancelled','rejected'].includes(raw.state)?'terminal' as const:undefined;
      if(!activity||raw.state==='filled'&&Math.abs(result.filledQuantity-request.quantity)>Math.max(1e-12,request.quantity*1e-9))
        throw new Error('bitget: classic Maker activity contradicts cumulative quantity');
      const totals=await this.makerExecutionTotals(raw,request,result);
      const observation=verifiedMakerReduction(request,{...result,...totals},activity);
      // Classic has no documented PostOnly liquidity cancellation reason; a rejected order is not a repricing permit.
      // https://www.bitget.com/docs/catalog/classic-contract-trade/classic-contract-trade
      if(request.postOnly&&observation.activity==='terminal'&&observation.executionVerified&&raw.state==='rejected'&&
        observation.result.status==='cancelled'&&observation.result.filledQuantity===0&&observation.result.feeUsd===0)
        observation.result={...observation.result,rejectionCode:'MAKER_REDUCTION_REJECTED_ZERO_FILL',
          rejectionReason:'Bitget Classic 已拒绝 Maker 减仓；本单确认未成交、未扣费，须核验原因后再操作'};
      return observation;
    }catch{
      clearBitgetAccountCache(this.client);
      return unknownMakerReduction(prior);
    }
  }
  /** GET only, unlike reconcile this never cancels an anomalously live IOC. */
  async inspectOrder(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<OrderResult>{
    try{
      orderId??=prior.id||undefined;
      const params={symbol:this.market(request.symbol).id,productType:PRODUCT,
        ...(orderId?{orderId}:{clientOid:exchangeClientId('bitget',request.clientOrderId)})};
      return this.normalize(bitgetData(await this.client.privateMixGetV2MixOrderDetail(params)),request,prior,orderId);
    }catch{clearBitgetAccountCache(this.client);return {...prior,status:'unknown'};}
  }
  async reconcile(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<OrderResult>{
    let confirmed=prior;
    try{
      orderId??=prior.id||undefined;
      const params={symbol:this.market(request.symbol).id,productType:PRODUCT,
        ...(orderId?{orderId}:{clientOid:exchangeClientId('bitget',request.clientOrderId)})};
      let raw=bitgetData(await this.client.privateMixGetV2MixOrderDetail(params));
      let result=this.normalize(raw,request,prior,orderId);
      confirmed=result;
      if(result.status==='unknown'&&['live','partially_filled'].includes(raw.state)&&result.id){
        // Cancel only the exact queried order. A cancel ACK alone never proves zero remaining quantity.
        await this.cancel(request.symbol,result.id);
        raw=bitgetData(await this.client.privateMixGetV2MixOrderDetail({...params,orderId:result.id}));
        result=this.normalize(raw,request,result,result.id);
      }
      return result;
    }catch{clearBitgetAccountCache(this.client);return {...confirmed,status:'unknown'};}
  }
}
