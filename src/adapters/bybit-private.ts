import { positionMetrics, positionTimestamps } from './position-metrics.js';
import type {AccountOpenOrder,AccountOverview,AccountPosition,AccountState,MakerReductionObservation,OrderConfirmationDiagnostic,OrderRequest,OrderResult} from '../shared/types.js';
import {exchangeClientId,isEligibleMarket,number,unknownOrder} from './normalization.js';
import {assertExchangeRequestActive,classifyNetworkError,consumeBybitCreateNotSent,exchangeApiCode} from './network.js';
import {OrderNotSubmittedError,rejectedOrder} from './order-rejection.js';
import {bybitOrderDiagnostic} from './bybit-order-diagnostics.js';
import {safeExchangeApiMessage} from '../shared/exchange-api-diagnostic.js';
import {isTerminalOrderReceipt,safeOrderConfirmation} from '../shared/order-receipt-validity.js';
import type {BybitPositionCash} from './bybit-position-cash.js';
import {assertMakerReductionPermission,assertMakerReductionRequest,unknownMakerReduction,verifiedMakerReduction} from './maker-reduction-observation.js';
import {assertOrderSubmissionPermission} from './order-submission-permission.js';
import {quantityAdd,quantitySubtract} from '../core/order-quantity.js';

type Margin='REGULAR_MARGIN'|'ISOLATED_MARGIN';
interface Settings {margin:Margin;hedged:boolean;longLeverage:number;shortLeverage:number;rows:any[]}
interface Submission {signature:string;positionIdx:number;limitPrice?:number;id?:string;rejection?:OrderNotSubmittedError;confirmation?:OrderConfirmationDiagnostic}
const clients=new WeakMap<object,{prepared:Map<string,Settings>;submitted:Map<string,Submission>}>();
function state(client:object){let s=clients.get(client);if(!s){s={prepared:new Map(),submitted:new Map()};clients.set(client,s);}return s;}
function numeric(value:unknown){return typeof value==='number'||typeof value==='string'&&value.trim()!==''?number(value):NaN;}
function data(response:any,privateValues?:string[]):any{
  if(response?.retCode!==0||!response.result||typeof response.result!=='object')
    throw Object.assign(new Error('bybit: invalid V5 response'),{apiCode:exchangeApiCode('bybit',response),apiMessage:safeExchangeApiMessage('bybit',response,privateValues)});
  return response.result;
}
function list(result:any):any[]{if(!Array.isArray(result?.list))throw new Error('bybit: invalid V5 list response');return result.list;}
function confirmation(stage:OrderConfirmationDiagnostic['stage'],reason:OrderConfirmationDiagnostic['reason'],error?:unknown,privateValues?:string[]):OrderConfirmationDiagnostic{
  const apiCode=exchangeApiCode('bybit',error),apiMessage=safeExchangeApiMessage('bybit',error,privateValues);
  return {stage,reason,observedAt:Date.now(),...(apiCode?{apiCode}:{}),...(apiMessage?{apiMessage}:{})};
}
class ReceiptFailure extends Error {
  constructor(message:string,readonly reason:'identity-mismatch'|'invalid-execution'){super(message);}
}
/** Native docs use an empty string outside applicable spot taxes; empty array variants also contain no charges. */
function noExtraFees(value:unknown):boolean {
  if(value===undefined||value==='')return true;
  if(Array.isArray(value))return value.length===0;
  if(typeof value!=='string'||value.length>4096)return false;
  try{const parsed=JSON.parse(value);return Array.isArray(parsed)&&parsed.length===0;}catch{return false;}
}
function closeSide(request:OrderRequest){return request.reduceOnly?(request.side==='sell'?'Buy':'Sell'):(request.side==='buy'?'Buy':'Sell');}
function desiredIdx(request:OrderRequest){return closeSide(request)==='Buy'?1:2;}
function validUnified(info:any){if(![3,4,5,6].includes(info?.unifiedMarginStatus))throw new Error('bybit: verified UTA account required');}
function margin(info:any):Margin{
  validUnified(info);if(!['REGULAR_MARGIN','ISOLATED_MARGIN'].includes(info.marginMode))throw new Error('bybit: portfolio or unknown margin mode is read-only');
  return info.marginMode;
}
function code(error:unknown):string|undefined{
  if(error&&typeof error==='object'&&'apiCode' in error&&typeof error.apiCode==='string'&&/^\d{5,6}$/.test(error.apiCode))return error.apiCode;
  return error instanceof Error?error.message.match(/"retCode"\s*:\s*(\d{5,6})\b/)?.[1]:undefined;
}
// Only explicit create-order refusals. Timeout, internal errors, duplicate IDs and processing codes stay unknown.
// https://bybit-exchange.github.io/docs/v5/error
const CREATE_REJECTIONS:Record<string,string>={
  '10001':'Bybit 拒绝下单：请求参数不符合要求','10002':'Bybit 拒绝下单：请求时间超过允许窗口',
  '10003':'Bybit 拒绝下单：API 身份无效','10004':'Bybit 拒绝下单：请求签名无效','10005':'Bybit 拒绝下单：API 没有该操作权限',
  '10007':'Bybit 拒绝下单：账户身份认证失败','10010':'Bybit 拒绝下单：IP 与 API 白名单不匹配',
  '10024':'Bybit 拒绝下单：触发交易所合规限制','10027':'Bybit 拒绝下单：账户交易已被禁止','10029':'Bybit 拒绝下单：该合约不可交易',
  '110003':'Bybit 拒绝下单：价格超出交易所允许范围','110004':'Bybit 拒绝下单：钱包余额不足',
  '110006':'Bybit 拒绝下单：资产不足以覆盖仓位保证金','110007':'Bybit 拒绝下单：可用余额不足',
  '110012':'Bybit 拒绝下单：可用余额不足','110017':'Bybit 拒绝下单：可减仓数量被截断为零',
  '110020':'Bybit 拒绝下单：活动订单数量达到上限','110021':'Bybit 拒绝下单：持仓量达到交易所限制',
  '110023':'Bybit 拒绝下单：该合约当前仅允许减仓','110032':'Bybit 拒绝下单：委托不符合交易规则',
  '110040':'Bybit 拒绝下单：委托会触发强平','110044':'Bybit 拒绝下单：可用保证金不足','110045':'Bybit 拒绝下单：钱包余额不足',
  '110066':'Bybit 拒绝下单：当前禁止交易','110074':'Bybit 拒绝下单：该合约尚未开放交易',
  '110086':'Bybit 拒绝下单：杠杆超过当前风险档位上限','110090':'Bybit 拒绝下单：仓位可能超过交易所上限',
  '110094':'Bybit 拒绝下单：订单名义价值低于下限','110123':'Bybit 拒绝下单：需先在交易所确认交易条款',
  '110125':'Bybit 拒绝下单：需先在交易所确认该合约交易条款','110132':'Bybit 拒绝下单：所在地区不支持该产品',
  '110134':'Bybit 拒绝下单：该合约暂时停止交易','30208':'Bybit 拒绝下单：买价高于允许上限','30209':'Bybit 拒绝下单：卖价低于允许下限',
};

/** 110126 is only a known refusal when its native business response explicitly requires the agreement. */
function agreementCreateRefusal(error:unknown,privateValues:string[]):boolean {
  try{
    const category=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code'):undefined;
    if(category&&(!('value' in category)||category.value!==undefined&&category.value!=='API_ERROR'))return false;
    return classifyNetworkError(error)==='API_ERROR'&&safeExchangeApiMessage('bybit',error,privateValues)===
      'You must sign the required agreement before trading this contract.';
  }catch{return false;}
}

/** Native Bybit V5 UTA USDT perpetual access. Never switches margin or holding modes. */
export class BybitPrivate {
  constructor(private readonly client:any,private readonly newSymbolMarginMode?:'crossed'|'isolated'){}
  private diagnosticPrivateValues():string[]{
    return ['apiKey','secret','password'].flatMap(key=>{
      const descriptor=Object.getOwnPropertyDescriptor(this.client,key),value=descriptor&&'value' in descriptor?descriptor.value:undefined;
      return typeof value==='string'&&value.length>0?[value]:[];
    });
  }
  private originalDiagnostic(request:OrderRequest,prior:OrderResult):OrderConfirmationDiagnostic|undefined {
    if(prior.clientOrderId!==request.clientOrderId)return;
    const original=safeOrderConfirmation(prior.originalConfirmation);if(original)return original;
    const submitted=state(this.client).submitted.get(request.clientOrderId);
    if(submitted?.signature===JSON.stringify(request)){
      const diagnostic=safeOrderConfirmation(submitted.confirmation);if(diagnostic)return diagnostic;
    }
    return prior.confirmation?.stage==='create'?safeOrderConfirmation(prior.confirmation):undefined;
  }
  private observedRead(request:OrderRequest,prior:OrderResult,result:OrderResult):OrderResult {
    const originalConfirmation=this.originalDiagnostic(request,prior),orderReadAt=Date.now();
    return {...result,orderReadAt,...(originalConfirmation?{originalConfirmation}:{}),
      ...(result.confirmation?{confirmation:{...result.confirmation,observedAt:orderReadAt}}:{})};
  }
  async fetchOpenOrders(symbol:string):Promise<AccountOpenOrder[]>{
    const m=this.market(symbol),all:AccountOpenOrder[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<100;page++){
      assertExchangeRequestActive(this.client,'bybit');
      // The default orderFilter includes regular and conditional orders. Do not query only Order.
      const result=data(await this.client.privateGetV5OrderRealtime({category:'linear',symbol:m.id,openOnly:0,limit:50,...(cursor?{cursor}:{})}));
      assertExchangeRequestActive(this.client,'bybit');
      const records=list(result);
      for(const row of records){
        const quantity=numeric(row.qty),remaining=numeric(row.leavesQty);
        if(typeof row?.orderId!=='string'||!row.orderId||row.symbol!==m.id||!['Buy','Sell'].includes(row.side)||
          !Number.isFinite(quantity)||quantity<0||!Number.isFinite(remaining)||remaining<0||remaining>quantity*(1+1e-9)||
          ['Filled','Cancelled','Rejected','PartiallyFilledCanceled','Deactivated'].includes(row.orderStatus)||ids.has(row.orderId))
          throw new Error('bybit: active order response is incomplete or ambiguous');
        ids.add(row.orderId);
        all.push({id:row.orderId,...(typeof row.orderLinkId==='string'&&row.orderLinkId?{clientOrderId:row.orderLinkId}:{}),
          base:m.base,symbol:m.symbol,side:row.side==='Buy'?'buy':'sell',quantity,remainingQuantity:remaining,
          ...(typeof row.reduceOnly==='boolean'?{reduceOnly:row.reduceOnly}:{}),kind:row.stopOrderType&&row.stopOrderType!=='UNKNOWN'?'conditional':'regular'});
      }
      const next=result.nextPageCursor;
      if(next===''||next===undefined)return all;
      if(typeof next!=='string'||!records.length||cursors.has(next))throw new Error('bybit: active order pagination did not advance');
      cursors.add(next);cursor=next;
    }
    throw new Error('bybit: active order pagination limit exceeded');
  }
  private market(symbol:string):any{
    const m=this.client.market(symbol);
    if(!isEligibleMarket(m)||numeric(m.contractSize)!==1)throw new Error('bybit: unsupported USDT perpetual market');
    return m;
  }
  private marketById(id:string):any{
    const matches:any[]=Object.values(this.client.markets).filter((m:any)=>m.id===id&&m.swap&&m.linear&&m.quote==='USDT'&&m.settle==='USDT'&&numeric(m.contractSize)===1);
    if(matches.length!==1)throw new Error('bybit: cannot identify USDT position market');return matches[0];
  }
  private async info(){return data(await this.client.privateGetV5AccountInfo({}));}
  private async wallet(){
    const accounts=list(data(await this.client.privateGetV5AccountWalletBalance({accountType:'UNIFIED'})));
    if(accounts.length!==1||accounts[0].accountType!=='UNIFIED'||!Array.isArray(accounts[0].coin))throw new Error('bybit: UTA wallet response unavailable');
    return accounts[0];
  }
  private async positions(symbol?:string):Promise<any[]>{
    if(symbol){
      // A precise symbol snapshot has exactly one one-way slot or two hedge slots, verified by settings().
      // Bybit can still attach a cursor to that complete snapshot after leverage was configured. Following it
      // has returned conflicting same-symbol records. Never merge those into
      // a synthetic mode. Incomplete/empty/duplicate slots in this first response still fail settings().
      return list(data(await this.client.privateGetV5PositionList({category:'linear',symbol:this.market(symbol).id,limit:200})));
    }
    const all:any[]=[],seen=new Set<string>(),slots=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<100;page++){
      const result=data(await this.client.privateGetV5PositionList({category:'linear',settleCoin:'USDT',limit:200,...(cursor?{cursor}:{})}));
      const rows=list(result);
      for(const row of rows){
        const idx=numeric(row?.positionIdx);
        if(typeof row?.symbol!=='string'||!row.symbol||![0,1,2].includes(idx))throw new Error('bybit: position side/index mismatch');
        const slot=`${row.symbol}:${idx}`;
        if(slots.has(slot))throw new Error('bybit: duplicate position side');
        slots.add(slot);all.push(row);
      }
      const next=result.nextPageCursor;
      if(next===''||next===undefined)return all;
      if(typeof next!=='string'||!rows.length||seen.has(next))throw new Error('bybit: position pagination did not advance');
      seen.add(next);cursor=next;
    }
    throw new Error('bybit: position pagination limit exceeded');
  }
  private balances(info:any,wallet:any){
    const seen=new Set<string>();
    for(const c of wallet.coin){if(typeof c.coin!=='string'||!c.coin||seen.has(c.coin))throw new Error('bybit: invalid UTA coin balance');seen.add(c.coin);}
    const usdt=wallet.coin.find((c:any)=>c.coin==='USDT'),isolated=info.marginMode==='ISOLATED_MARGIN';
    let usdtAvailable=0;
    if(usdt){
      const values=[usdt.walletBalance,usdt.locked,usdt.bonus,...(info.marginMode==='PORTFOLIO_MARGIN'?[]:[usdt.totalPositionIM,usdt.totalOrderIM])].map(numeric);
      if(!values.every(Number.isFinite)||values.slice(1).some(n=>n<0))throw new Error('bybit: UTA USDT available balance fields are incomplete');
      // availableToWithdraw was deprecated for UTA in January 2025. It may be empty even with usable collateral.
      usdtAvailable=Math.max(0,values[0]-values.slice(1).reduce((a,b)=>a+b,0));
    }
    const available=numeric(wallet.totalAvailableBalance),accountEquity=numeric(wallet.totalEquity);
    let equityUsd=accountEquity;
    if(isolated&&!Number.isFinite(equityUsd)){
      const values=wallet.coin.map((c:any)=>numeric(c.usdValue));
      if(!values.every(Number.isFinite))throw new Error('bybit: UTA equity fields are incomplete');
      equityUsd=values.reduce((a:number,b:number)=>a+b,0);
    }
    if(!Number.isFinite(equityUsd)||!isolated&&!Number.isFinite(available))throw new Error('bybit: UTA equity or margin balance unavailable');
    // Some non-borrowed spot coins return an empty optional accruedInterest field. The actual borrow totals
    // must still explicitly confirm zero, and a present non-empty interest value must be valid and zero.
    const unsafeDebt=wallet.coin.some((c:any)=>numeric(c.borrowAmount)!==0||c.spotBorrow!==undefined&&numeric(c.spotBorrow)!==0||
      c.accruedInterest!==undefined&&c.accruedInterest!==''&&numeric(c.accruedInterest)!==0);
    const unsafeEquity=wallet.coin.some((c:any)=>!Number.isFinite(numeric(c.equity))||numeric(c.equity)<0);
    // The app uses 1 USDT ~= 1 USD. Other collateral never increases the strategy's USDT wallet cap.
    return {freeUsd:isolated?usdtAvailable:Math.max(0,Math.min(usdtAvailable,available)),equityUsd,usdtAvailable,
      marginAvailable:isolated?undefined:Math.max(0,available),unsafeDebt,unsafeEquity};
  }
  private assertBudget(balance:ReturnType<BybitPrivate['balances']>){
    if(balance.unsafeDebt)throw new Error('bybit: borrowed or unverified UTA assets are unsupported');
    if(balance.unsafeEquity)throw new Error('bybit: negative or unverified UTA equity is unsupported');
  }
  private position(raw:any,marginMode:string):AccountPosition|null{
    const quantity=numeric(raw?.size);if(!Number.isFinite(quantity)||quantity<0)throw new Error('bybit: invalid position quantity');
    if(quantity===0)return null;
    const m=this.marketById(raw.symbol),idx=numeric(raw.positionIdx);
    if(!['Buy','Sell'].includes(raw.side)||![0,1,2].includes(idx)||idx===1&&raw.side!=='Buy'||idx===2&&raw.side!=='Sell')throw new Error('bybit: position side/index mismatch');
    const markPrice=numeric(raw.markPrice),leverage=numeric(raw.leverage),liq=raw.liqPrice===''?0:numeric(raw.liqPrice);
    if(!(markPrice>0&&leverage>0&&Number.isFinite(liq)&&liq>=0))throw new Error('bybit: position risk data incomplete');
    return {base:m.base,symbol:m.symbol,side:raw.side==='Buy'?'long':'short',quantity,markPrice,leverage,liquidationPrice:liq,
      liquidationStatus:liq>0?'price':'unavailable',
      ...(liq<=0?{liquidationReason:'交易所未返回单仓强平价（超合约价格范围或按账户风控）'}:{}),
      marginMode:marginMode==='ISOLATED_MARGIN'?'isolated':'crossed',
      ...positionMetrics(raw.avgPrice,raw.unrealisedPnl),
      // createdTime can date from the first-ever symbol setting. openTime represents the current holding.
      ...positionTimestamps(raw.openTime,raw.updatedTime)};
  }
  async fetchAccountOverview():Promise<AccountOverview>{
    const [info,wallet,positions]=await Promise.all([this.info(),this.wallet(),this.positions()]);validUnified(info);
    const b=this.balances(info,wallet),warnings:string[]=[];let positionCount=0;
    for(const p of positions){const q=numeric(p.size);if(!Number.isFinite(q)||q<0)throw new Error('bybit: invalid position quantity');if(q>0)positionCount++;}
    if(!['REGULAR_MARGIN','ISOLATED_MARGIN'].includes(info.marginMode))warnings.push('Bybit 组合保证金或未知模式暂只支持账户概览');
    if(b.unsafeDebt)warnings.push('Bybit 存在负债或负债字段不完整，不能用于本策略执行');
    if(b.unsafeEquity)warnings.push('Bybit 存在负权益或权益字段不完整，不能用于本策略执行');
    return {freeUsd:b.freeUsd,equityUsd:b.equityUsd,positionCount,balanceScope:'unified_usdt',accountType:'unified',
      accountMode:['REGULAR_MARGIN','ISOLATED_MARGIN','PORTFOLIO_MARGIN'].includes(info.marginMode)?info.marginMode:undefined,
      executionSupported:warnings.length===0,usdtAvailableUsd:b.usdtAvailable,...(b.marginAvailable!==undefined?{marginAvailableUsd:b.marginAvailable}:{}),...(warnings.length?{warnings}:{})};
  }
  async fetchAccount(cash?:BybitPositionCash):Promise<AccountState>{
    const reads=await Promise.allSettled([this.info(),this.wallet(),this.positions()]);
    for(const read of reads)if(read.status==='rejected')throw read.reason;
    assertExchangeRequestActive(this.client,'bybit');
    const [info,wallet,rows]=reads.map(read=>(read as PromiseFulfilledResult<any>).value) as [any,any,any[]];margin(info);
    const b=this.balances(info,wallet);this.assertBudget(b);
    const positions=rows.map(p=>this.position(p,info.marginMode)).filter((p):p is AccountPosition=>p!==null),seen=new Set<string>();
    for(const p of positions){const key=`${p.symbol}:${p.side}`;if(seen.has(key))throw new Error('bybit: duplicate position side');seen.add(key);}
    return {freeUsd:b.freeUsd,equityUsd:b.equityUsd,positions:cash?cash.enrich(rows,positions):positions};
  }
  private settings(info:any,rows:any[],symbol:string):Settings{
    const m=this.market(symbol),marginMode=margin(info);
    if(!rows.length||rows.some(p=>p.symbol!==m.id))throw new Error('bybit: symbol position mode cannot be verified');
    const indices=rows.map(p=>numeric(p.positionIdx));
    const hedged=rows.length===2&&indices.includes(1)&&indices.includes(2);
    if(!hedged&&!(rows.length===1&&indices[0]===0))throw new Error('bybit: symbol position mode cannot be verified');
    for(const row of rows){if(!Number.isFinite(numeric(row.size))||numeric(row.size)<0)throw new Error('bybit: invalid position quantity');}
    const longLeverage=numeric(rows.find(p=>numeric(p.positionIdx)===(hedged?1:0))?.leverage);
    const shortLeverage=numeric(rows.find(p=>numeric(p.positionIdx)===(hedged?2:0))?.leverage);
    if(!(longLeverage>0&&shortLeverage>0&&Number.isFinite(longLeverage)&&Number.isFinite(shortLeverage)))throw new Error('bybit: symbol leverage cannot be verified');
    return {margin:marginMode,hedged,longLeverage,shortLeverage,rows};
  }
  async assertTradingMode(symbol:string):Promise<Settings>{
    const [info,rows]=await Promise.all([this.info(),this.positions(symbol)]);return this.settings(info,rows,symbol);
  }
  private assertEntryMargin(settings:Settings):void{
    if(this.newSymbolMarginMode!==undefined&&settings.margin!==(this.newSymbolMarginMode==='crossed'?'REGULAR_MARGIN':'ISOLATED_MARGIN'))
      throw new Error(`bybit: configure ${this.newSymbolMarginMode} account margin before live entry`);
  }
  private reductionPositionIdx(request:OrderRequest,quantity:number,current:Settings):number{
    if(!request.reduceOnly||!Number.isFinite(quantity)||quantity<=0)
      throw new Error('bybit: a positive reduce-only quantity is required');
    const positionIdx=current.hedged?desiredIdx(request):0;
    const held=current.rows.filter(p=>numeric(p.positionIdx)===positionIdx&&p.side===closeSide(request));
    if(held.length!==1||numeric(held[0].size)+1e-12<quantity)
      throw new Error('bybit: insufficient verified position to reduce');
    return positionIdx;
  }
  /** GET-only side/index/quantity preflight; no preparation or submitted-ID cache is changed. */
  async validateReduction(request:OrderRequest,quantity:number):Promise<void>{
    if(!request.reduceOnly)throw new Error('bybit: reduction preflight requires reduce-only');
    this.reductionPositionIdx(request,quantity,await this.assertTradingMode(request.symbol));
  }
  /** Actual submitted slot and quantized price; reading these frozen facts never requests account data. */
  submissionIdentity(request:OrderRequest|string):{positionIdx:number;limitPrice:number}|undefined{
    const saved=state(this.client).submitted.get(typeof request==='string'?request:request.clientOrderId);
    if(!saved||saved.rejection||typeof request!=='string'&&saved.signature!==JSON.stringify(request)||
      !(saved.limitPrice!==undefined&&Number.isFinite(saved.limitPrice)&&saved.limitPrice>0))return;
    return {positionIdx:saved.positionIdx,limitPrice:saved.limitPrice};
  }
  private async inspect(symbol:string,leverage:number){
    if(!(Number.isFinite(leverage)&&leverage>=1))throw new Error('bybit: invalid requested leverage');
    const [info,wallet,positions,pending]=await Promise.all([this.info(),this.wallet(),this.positions(symbol),
      this.client.privateGetV5OrderRealtime({category:'linear',symbol:this.market(symbol).id,openOnly:0,limit:1}).then(data).then(list)]);
    const settings=this.settings(info,positions,symbol);this.assertEntryMargin(settings);this.assertBudget(this.balances(info,wallet));
    if(positions.some(p=>numeric(p.size)!==0)||pending.length)throw new Error('bybit: existing position or pending order prevents preparation');
    return settings;
  }
  async inspectTrading(symbol:string,leverage:number):Promise<void>{await this.inspect(symbol,leverage);}
  async prepare(symbol:string,leverage:number):Promise<void>{
    const s=state(this.client);s.prepared.delete(symbol);const before=await this.inspect(symbol,leverage);
    if(before.longLeverage!==leverage||before.shortLeverage!==leverage){
      try{data(await this.client.privatePostV5PositionSetLeverage({category:'linear',symbol:this.market(symbol).id,buyLeverage:String(leverage),sellLeverage:String(leverage)}));}
      catch(error){if(code(error)!=='110043')throw error;}
    }
    const after=await this.assertTradingMode(symbol);
    if(before.margin!==after.margin||before.hedged!==after.hedged||after.longLeverage!==leverage||after.shortLeverage!==leverage)
      throw new Error('bybit: leverage or unchanged account mode readback failed');
    s.prepared.set(symbol,after);
  }
  async place(request:OrderRequest,quantity:number,price:number,canSubmit?:()=>boolean):Promise<string|undefined>{
    return this.placeNative(request,quantity,price,false,canSubmit);
  }
  async placeMakerReduction(request:OrderRequest,quantity:number,price:number,canSubmit?:()=>boolean):Promise<string|undefined>{
    assertMakerReductionRequest(request);
    if(request.closePosition)throw new OrderNotSubmittedError('bybit: exact split selector is unsupported','INVALID_CLOSE_SELECTOR','Bybit 不支持当前分仓选择，本次未发送订单');
    return this.placeNative(request,quantity,price,true,canSubmit);
  }
  private async placeNative(request:OrderRequest,quantity:number,price:number,makerReduction=false,canSubmit?:()=>boolean):Promise<string|undefined>{
    if(!makerReduction&&request.postOnly&&(request.reduceOnly||request.closePosition))throw new OrderNotSubmittedError('bybit: Maker trial can only open a position','INVALID_MAKER_ORDER','Maker 试运行仅用于入场首腿，不能用于平仓');
    const s=state(this.client),signature=JSON.stringify(request),known=s.submitted.get(request.clientOrderId);
    if(known){if(known.signature!==signature)throw new Error('bybit: client order ID conflict');if(known.rejection)throw known.rejection;return known.id;}
    let checked:{positionIdx:number;market:any;qty:string;limit:string};
    try{
      const current=await this.assertTradingMode(request.symbol),prepared=s.prepared.get(request.symbol),m=this.market(request.symbol);
      if(!request.reduceOnly)this.assertEntryMargin(current);
      if(!request.reduceOnly&&(!prepared||current.margin!==prepared.margin||current.hedged!==prepared.hedged||current.longLeverage!==prepared.longLeverage||current.shortLeverage!==prepared.shortLeverage))
        throw new Error('bybit: trading settings changed or preparation missing');
      const positionIdx=request.reduceOnly?this.reductionPositionIdx(request,quantity,current):(current.hedged?desiredIdx(request):0);
      const qty=this.client.amountToPrecision(request.symbol,quantity),limit=this.client.priceToPrecision(request.symbol,price);
      if(m.base!==request.base||!(quantity>0)||numeric(qty)!==quantity||quantity!==request.quantity||!(numeric(limit)>0)||
        (request.side==='buy'?numeric(limit)>request.limitPrice:numeric(limit)<request.limitPrice))throw new Error('bybit: order exceeds quantity or price bounds');
      checked={positionIdx,market:m,qty,limit};
    }catch(error){
      // All work above is local validation or GETs. No create request has been attempted in this call.
      // A concurrent call may have submitted the same client ID while these GETs were in flight.
      const concurrent=s.submitted.get(request.clientOrderId);
      if(concurrent){if(concurrent.signature!==signature)throw new Error('bybit: client order ID conflict');if(concurrent.rejection)throw concurrent.rejection;return concurrent.id;}
      const reason=bybitReadError(error),failure=new OrderNotSubmittedError(reason&&error instanceof Error?error.message:'bybit: pre-submission checks failed',
        'PRE_SUBMISSION_CHECK_FAILED',reason??'Bybit 委托发送前检查失败，本次未发送创建订单请求');
      s.submitted.set(request.clientOrderId,{signature,positionIdx:0,rejection:failure});throw failure;
    }
    const {positionIdx,market:m,qty,limit}=checked;
    const concurrent=s.submitted.get(request.clientOrderId);if(concurrent){if(concurrent.signature!==signature)throw new Error('bybit: client order ID conflict');if(concurrent.rejection)throw concurrent.rejection;return concurrent.id;}
    const submitted:Submission={signature,positionIdx,limitPrice:numeric(limit)};s.submitted.set(request.clientOrderId,submitted);
    try{if(makerReduction)assertMakerReductionPermission(canSubmit);else assertOrderSubmissionPermission(canSubmit);}
    catch(error){submitted.rejection=error as OrderNotSubmittedError;throw error;}
    try{
      const result=data(await this.client.privatePostV5OrderCreate({category:'linear',symbol:m.id,side:request.side==='buy'?'Buy':'Sell',orderType:'Limit',
        qty,price:limit,timeInForce:request.postOnly?'PostOnly':'IOC',positionIdx,reduceOnly:request.reduceOnly,orderLinkId:exchangeClientId('bybit',request.clientOrderId)}),this.diagnosticPrivateValues());
      if(result.orderId)submitted.id=String(result.orderId);
      else submitted.confirmation=confirmation('create','acknowledgement-missing');
      return submitted.id;
    }catch(error){
      if(consumeBybitCreateNotSent(error,this.client,request.clientOrderId)){
        submitted.rejection=new OrderNotSubmittedError('bybit: create stopped before HTTP transport','PRE_SUBMISSION_CHECK_FAILED',
          'Bybit 委托在 HTTP 请求发送前已停止，本次未发送创建订单请求');
        throw submitted.rejection;
      }
      const apiCode=exchangeApiCode('bybit',error),reason=apiCode==='110126'&&agreementCreateRefusal(error,this.diagnosticPrivateValues())
        ?'Bybit 拒绝下单：请先在交易所签署该合约所需协议'
        :apiCode?CREATE_REJECTIONS[apiCode]:undefined;
      if(reason){submitted.rejection=new OrderNotSubmittedError('bybit: create request explicitly rejected',apiCode!,reason);throw submitted.rejection;}
      submitted.confirmation=confirmation('create','request-failed',error,this.diagnosticPrivateValues());
      throw error;
    }
  }
  async cancel(symbol:string,id:string):Promise<void>{
    if(!id)throw new Error('bybit: cancellation requires exact order ID');
    data(await this.client.privatePostV5OrderCancel({category:'linear',symbol:this.market(symbol).id,orderId:id}));
  }
  private normalize(raw:any,request:OrderRequest,prior:OrderResult,id?:string):OrderResult{
    const m=this.market(request.symbol),idx=numeric(raw?.positionIdx),submitted=state(this.client).submitted.get(request.clientOrderId);
    const expectedId=id??(prior.id||undefined);
    if(!raw?.orderId||expectedId&&String(raw.orderId)!==expectedId||prior.id&&String(raw.orderId)!==prior.id||raw.symbol!==m.id||raw.orderLinkId!==exchangeClientId('bybit',request.clientOrderId)||
      raw.side!==(request.side==='buy'?'Buy':'Sell')||raw.reduceOnly!==request.reduceOnly||raw.orderType!=='Limit'||raw.timeInForce!==(request.postOnly?'PostOnly':'IOC')||
      ![0,desiredIdx(request)].includes(idx)||submitted&&idx!==submitted.positionIdx)throw new ReceiptFailure('bybit: order identity mismatch','identity-mismatch');
    const reportedLimit=numeric(raw.price),priceTolerance=Math.max(1e-12,Math.abs(reportedLimit)*1e-12);
    // REST/history report the native Limit price. A matching ID must not authorize an amended or wrong-price order.
    // After restart the exact quantized submission may be unavailable; retain the original directional bound.
    if(!(reportedLimit>0)||!Number.isFinite(reportedLimit)||!(request.limitPrice>0)||!Number.isFinite(request.limitPrice)||
      (request.side==='buy'?reportedLimit>request.limitPrice+priceTolerance:reportedLimit<request.limitPrice-priceTolerance)||
      submitted?.limitPrice!==undefined&&Math.abs(reportedLimit-submitted.limitPrice)>priceTolerance)
      throw new ReceiptFailure('bybit: order Limit price mismatch','identity-mismatch');
    const quantity=numeric(raw.qty),filledQuantity=numeric(raw.cumExecQty),averagePrice=filledQuantity>0?numeric(raw.avgPrice):0,timestamp=numeric(raw.updatedTime??raw.createdTime);
    if(!Number.isFinite(quantity)||Math.abs(quantity-request.quantity)>Math.max(1e-12,request.quantity*1e-9)||!Number.isFinite(filledQuantity)||
      filledQuantity<prior.filledQuantity||filledQuantity<0||filledQuantity>request.quantity*(1+1e-9)||!(timestamp>0)||filledQuantity>0&&!(averagePrice>0))
      throw new ReceiptFailure('bybit: inconsistent cumulative order execution','invalid-execution');
    if(raw.orderStatus==='Filled'&&Math.abs(filledQuantity-quantity)>Math.max(1e-12,quantity*1e-9))
      throw new ReceiptFailure('bybit: Filled status contradicts cumulative quantity','invalid-execution');
    if(raw.cumExecValue!==undefined){
      const value=numeric(raw.cumExecValue),expected=filledQuantity*averagePrice;
      // Average prices can be rounded. Permit at most one native price tick per executed unit, not an arbitrary value.
      const tick=numeric(m.info?.priceFilter?.tickSize??m.precision?.price),tolerance=Math.max(1e-8,expected*1e-9,
        Number.isFinite(tick)&&tick>0?filledQuantity*tick:filledQuantity*1e-8);
      if(!Number.isFinite(value)||value<0||Math.abs(value-expected)>tolerance)
        throw new ReceiptFailure('bybit: cumulative value contradicts execution','invalid-execution');
    }
    const fee=raw.cumFeeDetail,entries=fee&&typeof fee==='object'&&!Array.isArray(fee)?Object.entries(fee):[];
    const feesKnown=(filledQuantity===0||entries.length>0)&&entries.every(([coin,value])=>coin==='USDT'&&Number.isFinite(numeric(value)));
    const feeUsd=feesKnown?entries.reduce((sum,[,value])=>sum+numeric(value),0):prior.feeUsd;
    const terminal=['Filled','Cancelled','Rejected','PartiallyFilledCanceled','Deactivated'].includes(raw.orderStatus);
    const refusal=bybitOrderDiagnostic(raw,filledQuantity,request.reduceOnly,prior.rejectionCode);
    const reason=!terminal?'nonterminal':!feesKnown||!noExtraFees(raw.extraFees)?'fee-unverified':undefined;
    return {id:String(raw.orderId),clientOrderId:request.clientOrderId,filledQuantity,averagePrice,feeUsd,timestamp,...refusal,
      ...(reason?{confirmation:confirmation('receipt',reason)}:{}),
      status:reason?'unknown':filledQuantity>=request.quantity*(1-1e-9)?'filled':filledQuantity>0?'partial':'cancelled'};
  }
  private unconfirmed(request:OrderRequest,prior:OrderResult,stage:OrderConfirmationDiagnostic['stage'],reason:OrderConfirmationDiagnostic['reason'],error?:unknown):OrderResult {
    const originalConfirmation=this.originalDiagnostic(request,prior);
    return {...prior,status:'unknown',...(originalConfirmation?{originalConfirmation}:{}),
      confirmation:confirmation(stage,reason,error,this.diagnosticPrivateValues())};
  }
  private readFailure(request:OrderRequest,prior:OrderResult,error:unknown):OrderResult {
    if(error instanceof ReceiptFailure)return this.unconfirmed(request,prior,'receipt',error.reason);
    const malformed=error instanceof Error&&['bybit: invalid V5 response','bybit: invalid V5 list response','bybit: ambiguous order identity'].includes(error.message);
    return this.unconfirmed(request,prior,'order-read',malformed?'malformed-response':'request-failed',error);
  }
  private async readOrder(request:OrderRequest,id?:string):Promise<any|undefined>{
    const query={category:'linear',symbol:this.market(request.symbol).id,...(id?{orderId:id}:{orderLinkId:exchangeClientId('bybit',request.clientOrderId)})};
    let rows=list(data(await this.client.privateGetV5OrderRealtime(query),this.diagnosticPrivateValues()));
    if(!rows.length)rows=list(data(await this.client.privateGetV5OrderHistory(query),this.diagnosticPrivateValues()));
    if(rows.length>1)throw new Error('bybit: ambiguous order identity');return rows[0];
  }
  async inspectOrder(request:OrderRequest,prior=unknownOrder(request),id?:string):Promise<OrderResult>{
    id??=prior.id||undefined;
    try{const raw=await this.readOrder(request,id);return this.observedRead(request,prior,raw?this.normalize(raw,request,prior,id):this.unconfirmed(request,prior,'order-read','not-found'));}
    catch(error){return this.observedRead(request,prior,this.readFailure(request,prior,error));}
  }
  /** Complete native cash for an identified terminal IOC reduction, without touching an order or its saved receipt. */
  async verifyOrderExecution(request:OrderRequest,prior=unknownOrder(request),id?:string):Promise<OrderResult>{
    if(request.reduceOnly!==true||request.postOnly===true||request.closePosition!==undefined)
      throw new Error('bybit: execution proof only supports ordinary reduce-only IOC orders');
    try{
      id??=prior.id||undefined;
      if(!id)throw new ReceiptFailure('bybit: execution proof requires an original native ID','identity-mismatch');
      const raw=await this.readOrder(request,id);
      if(!raw)return this.observedRead(request,prior,this.unconfirmed(request,prior,'order-read','not-found'));
      const result=this.normalize(raw,request,prior,id),market=this.market(request.symbol);
      if(market.base!==request.base||!isTerminalOrderReceipt(request,result)||result.confirmation||
        !Number.isFinite(result.feeUsd)||!Number.isFinite(result.timestamp)||result.timestamp>Date.now()+5000||
        numeric(this.client.amountToPrecision(request.symbol,request.quantity))!==request.quantity||
        numeric(this.client.amountToPrecision(request.symbol,result.filledQuantity))!==result.filledQuantity)
        throw new ReceiptFailure('bybit: terminal reduction execution is incomplete','invalid-execution');
      if(result.filledQuantity===0){
        if(result.averagePrice!==0||result.feeUsd!==0)throw new ReceiptFailure('bybit: zero reduction cash is inconsistent','invalid-execution');
        return this.observedRead(request,prior,{...result,averagePriceVerified:true});
      }
      const totals=await this.iocExecutionTotals(request,result,numeric(raw.price),raw.cumExecValue,'reduction');
      return this.observedRead(request,prior,{...result,...totals,averagePriceVerified:true});
    }catch(error){return this.observedRead(request,prior,this.readFailure(request,prior,error));}
  }
  /** Opening cash has a separate permission boundary: execution rows must prove zero closed size. */
  async verifyOpeningExecution(request:OrderRequest,prior=unknownOrder(request),id?:string):Promise<OrderResult>{
    if(request.reduceOnly!==false||request.postOnly===true||request.closePosition!==undefined)
      throw new Error('bybit: opening execution proof only supports ordinary opening IOC orders');
    try{
      id??=prior.id||undefined;
      if(typeof id!=='string'||!id.trim()||prior.id&&id!==prior.id)
        throw new ReceiptFailure('bybit: opening execution proof requires the exact original native ID','identity-mismatch');
      const raw=await this.readOrder(request,id);
      if(!raw)return this.observedRead(request,prior,this.unconfirmed(request,prior,'order-read','not-found'));
      const result=this.normalize(raw,request,prior,id),market=this.market(request.symbol),summaryValue=numeric(raw.cumExecValue);
      if(market.base!==request.base||!isTerminalOrderReceipt(request,result)||result.confirmation||
        !Number.isFinite(result.feeUsd)||!Number.isFinite(result.timestamp)||result.timestamp>Date.now()+5000||
        !Number.isFinite(summaryValue)||summaryValue<0||
        numeric(this.client.amountToPrecision(request.symbol,request.quantity))!==request.quantity||
        result.filledQuantity>0&&numeric(this.client.amountToPrecision(request.symbol,result.filledQuantity))!==result.filledQuantity)
        throw new ReceiptFailure('bybit: terminal opening execution is incomplete','invalid-execution');
      if(result.filledQuantity===0){
        if(result.averagePrice!==0||result.feeUsd!==0||summaryValue!==0||
          raw.avgPrice!==''&&numeric(raw.avgPrice)!==0||!raw.cumFeeDetail||typeof raw.cumFeeDetail!=='object'||Array.isArray(raw.cumFeeDetail))
          throw new ReceiptFailure('bybit: zero opening cash is inconsistent','invalid-execution');
        return this.observedRead(request,prior,{...result,averagePriceVerified:true});
      }
      const totals=await this.iocExecutionTotals(request,result,numeric(raw.price),raw.cumExecValue,'opening');
      return this.observedRead(request,prior,{...result,...totals,averagePriceVerified:true});
    }catch(error){return this.observedRead(request,prior,this.readFailure(request,prior,error));}
  }
  private async iocExecutionTotals(request:OrderRequest,result:OrderResult,nativeLimitPrice:number,summaryValue:unknown,action:'opening'|'reduction'):Promise<{averagePrice:number;feeUsd:number}>{
    const market=this.market(request.symbol),seen=new Map<string,string>(),cursors=new Set<string>();
    const equal=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*Number.EPSILON*16;
    let cursor:string|undefined,quantity=0,valueUsd=0,feeUsd=0,feeCharges=0,feeRebates=0;
    for(let page=0;page<100;page++){
      const response=data(await this.client.privateGetV5ExecutionList({category:'linear',orderId:result.id,limit:100,...(cursor?{cursor}:{})}),this.diagnosticPrivateValues());
      if(response.category!==undefined&&response.category!=='linear')throw new ReceiptFailure(`bybit: wrong ${action} execution category`,'identity-mismatch');
      const records=list(response);
      for(const fill of records){
        const qty=numeric(fill.execQty),price=numeric(fill.execPrice),value=numeric(fill.execValue),fee=numeric(fill.execFee),closed=numeric(fill.closedSize),at=numeric(fill.execTime);
        if(typeof fill.execId!=='string'||!fill.execId||action==='opening'&&!fill.execId.trim()||fill.orderId!==result.id||fill.orderLinkId!==exchangeClientId('bybit',request.clientOrderId)||
          fill.symbol!==market.id||fill.side!==(request.side==='buy'?'Buy':'Sell')||fill.orderType!=='Limit'||fill.execType!=='Trade'||fill.isMaker!==false||
          !Number.isFinite(qty)||qty<=0||numeric(this.client.amountToPrecision(request.symbol,qty))!==qty||
          !Number.isFinite(price)||price<=0||!equal(value,qty*price)||!Number.isFinite(fee)||fill.feeCurrency!=='USDT'||!noExtraFees(fill.extraFees)||
          (action==='opening'?closed!==0:!equal(closed,qty))||!Number.isFinite(at)||at<=0||at>Date.now()+5000||
          (request.side==='buy'?price>nativeLimitPrice+Math.max(1e-12,nativeLimitPrice*1e-12):price<nativeLimitPrice-Math.max(1e-12,nativeLimitPrice*1e-12)))
          throw new ReceiptFailure(`bybit: ${action} execution identity, price or paid cash is incomplete`,'invalid-execution');
        const signature=JSON.stringify([fill.orderId,fill.orderLinkId,fill.symbol,fill.side,qty,price,value,fee,closed,at]);
        const previous=seen.get(fill.execId);
        if(previous!==undefined){if(previous!==signature)throw new ReceiptFailure(`bybit: conflicting duplicate ${action} execution`,'invalid-execution');continue;}
        seen.set(fill.execId,signature);quantity=quantityAdd(quantity,qty);valueUsd=quantityAdd(valueUsd,value);
        if(fee>=0)feeCharges=quantityAdd(feeCharges,fee);else feeRebates=quantityAdd(feeRebates,-fee);
        feeUsd=quantitySubtract(feeCharges,feeRebates);
      }
      if(quantity>result.filledQuantity&&!equal(quantity,result.filledQuantity))throw new ReceiptFailure(`bybit: ${action} execution quantity exceeds the original order`,'invalid-execution');
      const next=response.nextPageCursor;
      if(next===undefined||next===''){
        if(!equal(quantity,result.filledQuantity)||!equal(feeUsd,result.feeUsd)||summaryValue!==undefined&&!equal(valueUsd,numeric(summaryValue)))
          throw new ReceiptFailure(`bybit: complete ${action} cash does not match the native order`,'invalid-execution');
        return {averagePrice:valueUsd/quantity,feeUsd};
      }
      if(typeof next!=='string'||!records.length||cursors.has(next))throw new ReceiptFailure(`bybit: ${action} execution pagination is incomplete`,'invalid-execution');
      cursors.add(next);cursor=next;
    }
    throw new ReceiptFailure(`bybit: ${action} execution pagination limit exceeded`,'invalid-execution');
  }
  /** Only identified native executions establish active-order cash; rounded order summaries are insufficient. */
  private async makerReductionExecutionTotals(request:OrderRequest,result:OrderResult,nativeLimitPrice:number):Promise<{averagePrice:number;feeUsd:number}>{
    if(result.filledQuantity===0)return {averagePrice:0,feeUsd:0};
    const market=this.market(request.symbol),seen=new Map<string,string>(),cursors=new Set<string>();
    let cursor:string|undefined,quantity=0,valueUsd=0,feeUsd=0;
    for(let page=0;page<100;page++){
      const response=data(await this.client.privateGetV5ExecutionList({category:'linear',orderId:result.id,limit:100,...(cursor?{cursor}:{})}),this.diagnosticPrivateValues());
      if(response.category!==undefined&&response.category!=='linear')throw new Error('bybit: wrong Maker execution category');
      const records=list(response);
      for(const fill of records){
        const qty=numeric(fill.execQty),price=numeric(fill.execPrice),fee=numeric(fill.execFee),closed=numeric(fill.closedSize),at=numeric(fill.execTime);
        if(typeof fill.execId!=='string'||!fill.execId||fill.orderId!==result.id||fill.orderLinkId!==exchangeClientId('bybit',request.clientOrderId)||
          fill.symbol!==market.id||fill.side!==(request.side==='buy'?'Buy':'Sell')||fill.orderType!=='Limit'||fill.execType!=='Trade'||fill.isMaker!==true||
          !Number.isFinite(qty)||qty<=0||!Number.isFinite(price)||price<=0||!Number.isFinite(fee)||fill.feeCurrency!=='USDT'||!noExtraFees(fill.extraFees)||
          !Number.isFinite(closed)||Math.abs(closed-qty)>Math.max(1e-12,qty*1e-9)||!Number.isFinite(at)||at<=0||at>Date.now()+5000||
          (request.side==='buy'?price>nativeLimitPrice+Math.max(1e-12,nativeLimitPrice*1e-12):price<nativeLimitPrice-Math.max(1e-12,nativeLimitPrice*1e-12)))
          throw new Error('bybit: Maker reduction execution identity, action, price or paid fees are incomplete');
        const signature=JSON.stringify([fill.orderId,fill.orderLinkId,fill.symbol,fill.side,qty,price,fee,closed,at]);
        const previous=seen.get(fill.execId);
        if(previous!==undefined){if(previous!==signature)throw new Error('bybit: conflicting duplicate Maker execution');continue;}
        seen.set(fill.execId,signature);quantity+=qty;valueUsd+=qty*price;feeUsd+=fee;
      }
      if(Math.abs(quantity-result.filledQuantity)<=Math.max(1e-12,result.filledQuantity*1e-9))return {averagePrice:valueUsd/quantity,feeUsd};
      if(quantity>result.filledQuantity*(1+1e-9))throw new Error('bybit: Maker executions advanced beyond the order observation');
      if(typeof response.nextPageCursor!=='string'||!response.nextPageCursor||!records.length||cursors.has(response.nextPageCursor))
        throw new Error('bybit: Maker execution pages do not cover cumulative fills');
      cursors.add(response.nextPageCursor);cursor=response.nextPageCursor;
    }
    throw new Error('bybit: Maker execution pagination limit exceeded');
  }
  async inspectMakerReduction(request:OrderRequest,prior=unknownOrder(request),id?:string):Promise<MakerReductionObservation>{
    assertMakerReductionRequest(request);
    try{
      id??=prior.id||undefined;
      const raw=await this.readOrder(request,id);
      if(!raw)throw new Error('bybit: Maker reduction original order not found');
      const result=this.normalize(raw,request,prior,id);
      const active=['New','PartiallyFilled'].includes(raw.orderStatus),terminal=['Filled','Cancelled','Rejected','PartiallyFilledCanceled','Deactivated'].includes(raw.orderStatus);
      if(!active&&!terminal||!noExtraFees(raw.extraFees))throw new Error('bybit: Maker activity or additional paid fees unverified');
      const totals=await this.makerReductionExecutionTotals(request,result,numeric(raw.price));
      const observation=verifiedMakerReduction(request,{...result,...totals},active?'active':'terminal');
      // https://bybit-exchange.github.io/docs/v5/enum#rejectreason
      // Only this native reason identifies a PostOnly order rejected for taking liquidity.
      if(request.postOnly&&observation.activity==='terminal'&&observation.executionVerified&&
        observation.result.status==='cancelled'&&observation.result.filledQuantity===0&&observation.result.feeUsd===0&&
        result.status==='cancelled'&&result.feeUsd===0&&raw.rejectReason==='EC_PostOnlyWillTakeLiquidity')
        observation.result={...observation.result,rejectionCode:'EC_PostOnlyWillTakeLiquidity',
          rejectionReason:'Bybit PostOnly 委托会立即吃单，交易所已拒绝；本单确认未成交、未扣费'};
      return observation;
    }catch{return unknownMakerReduction(prior);}
  }
  async reconcile(request:OrderRequest,prior=unknownOrder(request),id?:string):Promise<OrderResult>{
    const known=state(this.client).submitted.get(request.clientOrderId);
    if(known?.signature===JSON.stringify(request)&&known.rejection)return rejectedOrder(request,known.rejection);
    let confirmed=prior;
    try{
      id??=prior.id||undefined;
      let raw=await this.readOrder(request,id);if(!raw)return this.observedRead(request,prior,this.unconfirmed(request,prior,'order-read','not-found'));
      let result=this.normalize(raw,request,prior,id);confirmed=result;
      if(['New','PartiallyFilled'].includes(raw.orderStatus)){
        try{await this.cancel(request.symbol,result.id);}catch(error){
          // A fill can win the cancel race. Read this exact original once; never retry create/cancel on an uncertain response.
          raw=await this.readOrder(request,result.id);
          if(raw&&['Filled','Cancelled','Rejected','PartiallyFilledCanceled','Deactivated'].includes(raw.orderStatus))
            return this.observedRead(request,prior,this.normalize(raw,request,confirmed,result.id));
          return this.observedRead(request,prior,this.readFailure(request,confirmed,error));
        }
        raw=await this.readOrder(request,result.id);
        if(!raw)return this.observedRead(request,prior,this.unconfirmed(request,confirmed,'order-read','not-found'));
        result=this.normalize(raw,request,confirmed,result.id);
      }
      return this.observedRead(request,prior,result);
    }catch(error){return this.observedRead(request,prior,this.readFailure(request,confirmed,error));}
  }
}

export function bybitReadError(error:unknown):string|undefined{
  const reasons:Record<string,string>={
    'bybit: invalid V5 response':'Bybit 返回的账户或交易响应无效，请重新检查账户权限与接口状态',
    'bybit: invalid V5 list response':'Bybit 未返回有效的持仓或订单列表，已停止执行，不能将缺失记录当作空仓',
    'bybit: UTA wallet response unavailable':'Bybit 未返回明确的统一账户余额，无法确认交易预算',
    'bybit: UTA equity fields are incomplete':'Bybit 逐仓账户未返回完整的资产美元权益，无法确认账户余额',
    'bybit: verified UTA account required':'Bybit 账户类型尚未确认；当前执行适配要求统一交易账户（UTA）',
    'bybit: portfolio or unknown margin mode is read-only':'Bybit 当前为组合保证金或未知模式，暂只支持账户读取；执行支持已确认的全仓或逐仓模式',
    'bybit: configure crossed account margin before live entry':'Bybit 账户保证金模式与新开仓全仓设置不一致；请先在 Bybit 账户设置中选择全仓，再重试新开仓',
    'bybit: configure isolated account margin before live entry':'Bybit 账户保证金模式与新开仓逐仓设置不一致；请先在 Bybit 账户设置中选择逐仓，再重试新开仓',
    'bybit: UTA USDT available balance fields are incomplete':'Bybit 未返回完整的 USDT 可用保证金字段，请检查统一账户余额读取权限',
    'bybit: UTA equity or margin balance unavailable':'Bybit 未返回有效账户权益或可用保证金，无法计算交易预算',
    'bybit: borrowed or unverified UTA assets are unsupported':'Bybit 存在负债或负债字段不完整，当前策略暂不能使用该账户',
    'bybit: negative or unverified UTA equity is unsupported':'Bybit 存在负权益或权益字段不完整，当前策略暂不能使用该账户',
    'bybit: symbol position mode cannot be verified':'Bybit 未返回该合约明确的持仓模式；不能猜测单向或双向参数',
    'bybit: symbol leverage cannot be verified':'Bybit 未返回该合约两侧有效杠杆，无法确认执行设置',
    'bybit: duplicate position side':'Bybit 返回了重复的合约持仓槽位，无法确认完整账户持仓，已停止执行',
    'bybit: position side/index mismatch':'Bybit 持仓方向或槽位编号无效，无法确认账户持仓，已停止执行',
    'bybit: position pagination did not advance':'Bybit 账户持仓分页游标异常，无法确认完整持仓，已停止执行',
    'bybit: position pagination limit exceeded':'Bybit 账户持仓超过本次完整读取上限，已停止执行',
    'bybit: existing position or pending order prevents preparation':'Bybit 该合约已有持仓或挂单，已停止准备以免影响现有交易',
    'bybit: leverage or unchanged account mode readback failed':'Bybit 杠杆或账户模式读回不一致，未提交订单',
    'bybit: trading settings changed or preparation missing':'Bybit 合约尚未准备完成，或账户模式、杠杆已变化，已停止新开仓',
    'bybit: insufficient verified position to reduce':'Bybit 已核实可减仓数量不足，本次未发送平仓委托',
    'bybit: order exceeds quantity or price bounds':'Bybit 委托数量或价格超出已核实边界，本次未发送订单',
  };
  return error instanceof Error?reasons[error.message]:undefined;
}
