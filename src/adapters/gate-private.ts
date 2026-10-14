import { positionMetrics, positionTimestamps } from './position-metrics.js';
import type { AccountOpenOrder, AccountOverview, AccountPosition, AccountState, MakerReductionObservation, OrderRequest, OrderResult } from '../shared/types.js';
import { exchangeClientId, isEligibleMarket, number, unknownOrder } from './normalization.js';
import { OrderNotSubmittedError } from './order-rejection.js';
import {assertOrderSubmissionPermission} from './order-submission-permission.js';
import {assertExchangeRequestActive,consumeGateMakerCreateRejection} from './network.js';
import {assertMakerReductionPermission,assertMakerReductionRequest,unknownMakerReduction,verifiedMakerReduction} from './maker-reduction-observation.js';

type Mode='single'|'dual'|'dual_plus';
type Direction='dual_long'|'dual_short';
type Margin='isolated'|'cross';
const SETTLE='usdt';
interface Submission {request:string;mode:Mode;margin:Margin;limitPrice:number;pid?:string;id?:string;rejection?:OrderNotSubmittedError}
interface ClientState {prepared:Map<string,{mode:Mode;leverage:number;margin:Margin}>;submitted:Map<string,Submission>}
const clients=new WeakMap<object,ClientState>();
function clientState(client:object):ClientState{
  let state=clients.get(client);if(!state){state={prepared:new Map(),submitted:new Map()};clients.set(client,state);}return state;
}
function numeric(value:unknown):number{return typeof value==='number'||typeof value==='string'&&value.trim()!==''?number(value):NaN;}
function rows(value:any):any[]{if(!Array.isArray(value))throw new Error('gate: invalid private list response');return value;}
function id(value:unknown):string|undefined{
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):undefined;
  return typeof value==='string'&&/^[1-9]\d*$/.test(value)?value:undefined;
}
function mode(account:any):Mode{
  const value=account?.position_mode;
  if(value===undefined&&account?.in_dual_mode===false)return 'single';
  if(!['single','dual','dual_plus'].includes(value))throw new Error('gate: account position mode is unverified');
  // position_mode is authoritative; the deprecated in_dual_mode boolean can disagree in evolved accounts.
  return value;
}
function direction(request:OrderRequest):Direction{
  return (request.reduceOnly?request.side==='sell':request.side==='buy')?'dual_long':'dual_short';
}
function sideOf(raw:any,accountMode:Mode):'long'|'short'{
  const size=numeric(raw?.size);
  if(!Number.isFinite(size)||size===0)throw new Error('gate: invalid position quantity');
  if(accountMode==='single'){
    if(raw.mode!=='single')throw new Error('gate: position holding mode mismatch');
  }else if(!['dual_long','dual_short'].includes(raw.mode)||(raw.mode==='dual_long')!==(size>0))throw new Error('gate: position holding mode mismatch');
  return size>0?'long':'short';
}
function positionMargin(raw:any,accountMode:Mode):'isolated'|'cross'{
  if(['isolated','cross'].includes(raw?.pos_margin_mode))return raw.pos_margin_mode;
  if(accountMode==='dual_plus')throw new Error('gate: split position margin mode is unverified');
  const leverage=numeric(raw?.leverage);
  if(!Number.isFinite(leverage)||leverage<0)throw new Error('gate: position margin mode is unverified');
  return leverage===0?'cross':'isolated';
}

/** Gate USDT perpetual private API. All mode/position checks are reads; prepare is the explicit leverage-write boundary. */
export class GatePrivate {
  private readonly entryMargin:Margin;
  // A fee reserve cannot establish a paid fee. Reconciliation uses authenticated fills and keeps unknown fees unresolved.
  constructor(private readonly client:any,_configuredFee?:number,newSymbolMarginMode?:'crossed'|'isolated'){
    this.entryMargin=newSymbolMarginMode==='isolated'?'isolated':'cross';
  }
  async fetchOpenOrders(symbol:string):Promise<AccountOpenOrder[]>{
    const market=this.market(symbol),all:AccountOpenOrder[]=[],seen=new Set<string>();
    for(const conditional of [false,true]){
      let complete=false;
      for(let page=0;page<100;page++){
        assertExchangeRequestActive(this.client,'gate');
        const params={settle:SETTLE,contract:market.id,status:'open',limit:100,offset:page*100};
        const records=rows(await (conditional?this.client.privateFuturesGetSettlePriceOrders(params):this.client.privateFuturesGetSettleOrders(params)));
        assertExchangeRequestActive(this.client,'gate');
        for(const row of records){
          const orderId=id(row?.id),initial=conditional?row.initial:row,size=numeric(initial?.size),left=conditional?size:numeric(row.left);
          const key=`${conditional?'conditional':'regular'}:${orderId}`;
          if(!orderId||initial?.contract!==market.id||row.status!=='open'||!Number.isFinite(size)||!Number.isFinite(left)||
            Math.abs(left)>Math.abs(size)*(1+1e-9)||size!==0&&left!==0&&(size>0)!==(left>0)||seen.has(key))
            throw new Error('gate: active order response is incomplete or ambiguous');
          seen.add(key);
          all.push({id:orderId,...(typeof initial.text==='string'&&initial.text?{clientOrderId:initial.text}:{}),base:market.base,symbol:market.symbol,
            ...(size!==0?{side:size>0?'buy' as const:'sell' as const}:{}),quantity:Math.abs(size)*numeric(market.contractSize),
            remainingQuantity:Math.abs(left)*numeric(market.contractSize),
            ...(typeof initial.is_reduce_only==='boolean'?{reduceOnly:initial.is_reduce_only}:typeof initial.reduce_only==='boolean'?{reduceOnly:initial.reduce_only}:{}),
            kind:conditional?'conditional':'regular'});
        }
        if(records.length<100){complete=true;break;}
      }
      if(!complete)throw new Error('gate: active order pagination limit exceeded');
    }
    return all;
  }
  private market(symbol:string):any{
    const market=this.client.market(symbol);
    if(!isEligibleMarket(market)||!(numeric(market.contractSize)>0))throw new Error('gate: unsupported USDT perpetual market');
    return market;
  }
  private marketById(contract:string):any{
    const matches:any[]=Object.values(this.client.markets).filter((m:any)=>m.id===contract&&m.swap&&m.linear&&m.quote==='USDT'&&m.settle==='USDT'&&numeric(m.contractSize)>0);
    if(matches.length!==1)throw new Error('gate: cannot identify USDT perpetual position');
    return matches[0];
  }
  private async account():Promise<any>{
    const account=await this.client.privateFuturesGetSettleAccounts({settle:SETTLE});
    if(account?.currency!=='USDT'||!Number.isFinite(numeric(account.available))||!Number.isFinite(numeric(account.total))||
      !Number.isFinite(numeric(account.unrealised_pnl)))throw new Error('gate: incomplete USDT futures balances');
    return account;
  }
  private async balances(account:any):Promise<{freeUsd:number;equityUsd:number}>{
    const unified=[1,2,3].includes(numeric(account.margin_mode))||
      ['single_currency','multi_currency','portfolio_margin'].includes(account.margin_mode_name);
    let equityUsd:number;
    if(unified){
      // /futures/accounts.total is only the classic futures wallet balance and can be zero on UTA.
      // The unified USD-equity field includes cross and isolated assets. It already includes UPL.
      const result=await this.client.privateUnifiedGetAccounts({});
      equityUsd=numeric(result?.unified_account_total_equity);
      if(!Number.isFinite(equityUsd))throw new Error('gate: unified account equity is unavailable');
    }else equityUsd=numeric(account.total)+numeric(account.unrealised_pnl);
    return {freeUsd:Math.max(0,numeric(account.available)),equityUsd};
  }
  private assertAccount(account:any):Mode{
    const value=mode(account);
    if(['multi_currency','portfolio_margin'].includes(account.margin_mode_name))throw new Error('gate: unsupported portfolio or multi-currency margin account');
    return value;
  }
  private async positions():Promise<any[]>{
    // No limit: Gate documents the default as the full result. Do not silently truncate holdings to one page.
    return rows(await this.client.privateFuturesGetSettlePositions({settle:SETTLE,holding:true}));
  }
  private active(raw:any[]):any[]{
    return raw.filter(p=>{if(!Number.isFinite(numeric(p?.size)))throw new Error('gate: invalid position quantity');return numeric(p.size)!==0;});
  }
  private normalizedPositions(raw:any[],accountMode:Mode,aggregate=true):AccountPosition[]{
    const seen=new Map<string,{margin:Margin;pid?:string}[]>(),positionIds=new Set<string>();
    const positions=this.active(raw).map<AccountPosition>(p=>{
      const market=this.marketById(p.contract),side=sideOf(p,accountMode),margin=positionMargin(p,accountMode);
      const key=`${market.symbol}:${side}`;
      const slots=seen.get(key)??[];
      if(slots.length&&accountMode!=='dual_plus')throw new Error('gate: multiple positions for the same contract side require manual reconciliation');
      const positionId=accountMode==='dual_plus'?id(p.pid):undefined;
      if(accountMode==='dual_plus'&&p.pid!==undefined&&!positionId)throw new Error('gate: split position ID is unverified');
      // Cross and isolated are distinct native slots even when Gate omits its write-only PID.
      // Repeated indistinguishable slots are not evidence of separate quantities. Closing
      // still reads the raw positions below and requires a unique contract side.
      if(positionId&&positionIds.has(positionId)||slots.some(slot=>slot.margin===margin&&(!slot.pid||!positionId)))
        throw new Error('gate: multiple positions for the same contract side require manual reconciliation');
      if(positionId)positionIds.add(positionId);
      slots.push({margin,pid:positionId});seen.set(key,slots);
      const leverage=numeric(p.lever??(margin==='isolated'?p.leverage:p.cross_leverage_limit)),markPrice=numeric(p.mark_price),liquidation=numeric(p.liq_price);
      if(!(leverage>0&&Number.isFinite(leverage)&&markPrice>0&&Number.isFinite(liquidation)))throw new Error('gate: incomplete position risk data');
      return {base:market.base,symbol:market.symbol,side,...(positionId?{positionId}:{}),quantity:Math.abs(numeric(p.size))*numeric(market.contractSize),markPrice,
        liquidationPrice:Math.max(0,liquidation),liquidationStatus:liquidation>0?'price':'unavailable',
        ...(liquidation<=0?{liquidationReason:'交易所当前未给出单仓强平价'}:{}),leverage,marginMode:margin==='cross'?'crossed':'isolated',
        ...positionMetrics(p.entry_price,p.unrealised_pnl,p.pnl_fund,p.pnl_fee,p.pnl_pnl),
        ...positionTimestamps(p.open_time,p.update_time,'seconds')};
    });
    if(!aggregate)return positions;
    const groups=new Map<string,AccountPosition[]>();
    for(const position of positions){const key=`${position.symbol}:${position.side}`,group=groups.get(key)??[];group.push(position);groups.set(key,group);}
    return [...groups.values()].map(group=>{
      if(group.length===1)return group[0];
      const first=group[0],quantity=group.reduce((sum,p)=>sum+p.quantity,0);
      const sum=(field:'unrealizedPnlUsd'|'realizedPnlUsd'|'fundingUsd'|'feesUsd')=>
        group.every(p=>Number.isFinite(p[field]))?group.reduce((total,p)=>total+p[field]!,0):undefined;
      const sameCycle=group.every(p=>Number.isFinite(p.positionOpenedAt)&&p.positionOpenedAt===first.positionOpenedAt);
      const entryPrice=group.every(p=>Number.isFinite(p.entryPrice)&&p.entryPrice!>0)?group.reduce((total,p)=>total+p.quantity*p.entryPrice!,0)/quantity:undefined;
      const marginMode=group.every(p=>p.marginMode===first.marginMode)?first.marginMode:undefined;
      const leverage=group.every(p=>p.leverage===first.leverage)?first.leverage:NaN;
      const updated=group.map(p=>p.positionUpdatedAt).filter((at):at is number=>Number.isFinite(at));
      // These are independently identified native position counters. Their complete sum
      // remains account cash even when slots opened at different times; it does not become
      // evidence of the original strategy's single opening cycle.
      const unrealizedPnlUsd=sum('unrealizedPnlUsd'),realizedPnlUsd=sum('realizedPnlUsd'),
        fundingUsd=sum('fundingUsd'),feesUsd=sum('feesUsd');
      return {base:first.base,symbol:first.symbol,side:first.side,quantity,
        markPrice:group.reduce((total,p)=>total+p.quantity*p.markPrice,0)/quantity,
        leverage,...(marginMode?{marginMode}:{}),...(entryPrice!==undefined?{entryPrice}:{}),
        ...(unrealizedPnlUsd!==undefined?{unrealizedPnlUsd}:{}),...(realizedPnlUsd!==undefined?{realizedPnlUsd}:{}),
        ...(fundingUsd!==undefined?{fundingUsd}:{}),...(feesUsd!==undefined?{feesUsd}:{}),
        ...(sameCycle?{positionOpenedAt:first.positionOpenedAt}:{}),
        ...(updated.length===group.length?{positionUpdatedAt:Math.max(...updated)}:{}),
        liquidationPrice:0,liquidationStatus:'unavailable' as const,
        liquidationReason:`${group.length} 个分仓的强平价独立，合计仓位无单一强平价`,
        splitPositionCount:group.length,
        positionMetricReason:sameCycle?'按同合约同方向分仓合计；资金费、手续费仅合计完整原生字段':
          '当前全部分仓的完整原生现金字段合计；包含不同或未明确开仓周期，不代表原策略单一周期'};
    });
  }
  async fetchAccount():Promise<AccountState>{
    const reads=await Promise.allSettled([this.account(),this.positions()]);
    for(const read of reads)if(read.status==='rejected')throw read.reason;
    assertExchangeRequestActive(this.client,'gate');
    const [account,raw]=reads.map(read=>(read as PromiseFulfilledResult<any>).value);
    const positionMode=this.assertAccount(account),positions=this.normalizedPositions(raw,positionMode);
    return {...await this.balances(account),positions,positionMode};
  }
  /** Official positions list exposes pid and pos_margin_mode. Preserve each native slot
   * for reduction; the dashboard's aggregate must never be sent as one slot order.
   * https://www.gate.com/docs/developers/apiv4/en/futures/#get-user-position-list */
  async fetchClosePositions(symbol:string):Promise<AccountPosition[]>{
    const market=this.market(symbol),[account,raw]=await Promise.all([this.account(),this.positions()]);
    return this.normalizedPositions(raw.filter(row=>row?.contract===market.id),this.assertAccount(account),false);
  }
  private closeTarget(request:OrderRequest,accountMode:Mode,raw:any[],contracts:number):{margin:Margin;pid?:string}{
    const market=this.market(request.symbol),selected=request.closePosition;
    const positions=this.active(raw).filter(p=>p.contract===market.id),targetSide=direction(request)==='dual_long'?'long':'short';
    let sameSide=positions.filter(p=>sideOf(p,accountMode)===targetSide);
    if(selected){
      if(!request.reduceOnly||selected.side!==targetSide||!['crossed','isolated'].includes(selected.marginMode??'')||
        selected.positionId!==undefined&&!id(selected.positionId)||
        selected.positionOpenedAt!==undefined&&!(Number.isFinite(selected.positionOpenedAt)&&selected.positionOpenedAt>0))
        throw new Error('gate: invalid exact close position selector');
      // Run duplicate/identity checks even when one matching slot looks sufficient.
      this.normalizedPositions(positions,accountMode,false);
      sameSide=sameSide.filter(p=>positionMargin(p,accountMode)===(selected.marginMode==='crossed'?'cross':'isolated')&&
        (accountMode==='dual_plus'?id(p.pid):undefined)===selected.positionId&&
        (selected.positionOpenedAt===undefined||positionTimestamps(p.open_time,p.update_time,'seconds').positionOpenedAt===selected.positionOpenedAt));
    }
    if(sameSide.length!==1||Math.abs(numeric(sameSide[0].size))+1e-10<contracts)
      throw new Error('gate: exact position for quantitative close is unavailable or ambiguous');
    const margin=positionMargin(sameSide[0],accountMode),pid=accountMode==='dual_plus'?id(sameSide[0].pid):undefined;
    if(accountMode==='dual_plus'&&sameSide[0].pid!==undefined&&!pid)throw new Error('gate: split position ID is unverified');
    return {margin,...(pid?{pid}:{})};
  }
  /** GET-only preflight for either the unique native side or an explicit selected slot.
   * place() repeats the same target check immediately before POST. */
  async validateReduction(request:OrderRequest,contracts:number):Promise<void>{
    if(!request.reduceOnly||!Number.isFinite(contracts)||contracts<=0)
      throw new Error('gate: a positive reduce-only quantity is required');
    const [account,raw]=await Promise.all([this.account(),this.positions()]);
    this.closeTarget(request,this.assertAccount(account),raw,contracts);
  }
  async validateClosePosition(request:OrderRequest,contracts:number):Promise<void>{
    if(!request.reduceOnly||!request.closePosition)throw new Error('gate: exact reduction selector is required');
    await this.validateReduction(request,contracts);
  }
  async fetchPortfolioAccount():Promise<AccountState>{
    const [account,raw]=await Promise.all([this.account(),this.positions()]);
    const positionMode=this.assertAccount(account),positions=this.normalizedPositions(raw,positionMode);
    return {...await this.balances(account),positions,positionMode};
  }
  async fetchAccountOverview():Promise<AccountOverview>{
    const [account,raw]=await Promise.all([this.account(),this.positions()]);
    const warnings:string[]=[];
    try{this.normalizedPositions(raw,this.assertAccount(account));}catch(error){warnings.push(gateReadError(error)??'Gate 账户或持仓设置尚未通过执行检查，余额可读取');}
    return {...await this.balances(account),
      positionCount:this.active(raw).length,balanceScope:'usdt_futures',positionMode:account.position_mode,
      executionSupported:!warnings.length,...(warnings.length?{warnings}:{})};
  }
  private async settings(symbol:string,accountMode:Mode,entryMargin:Margin=this.entryMargin):Promise<{margin:Margin;leverage:number}[]>{
    const market=this.market(symbol);
    const parse=(p:any)=>{
      const margin=positionMargin(p,accountMode),leverage=numeric(p.lever??(margin==='cross'?p.cross_leverage_limit:p.leverage));
      if(!(leverage>0&&Number.isFinite(leverage)))throw new Error('gate: position leverage is unverified');
      return {margin,leverage};
    };
    if(accountMode==='single'){
      const p=await this.client.privateFuturesGetSettlePositionsContract({settle:SETTLE,contract:market.id});
      if(p?.contract!==market.id||p.mode!=='single')throw new Error('gate: position margin mode is unverified');
      return [parse(p)];
    }
    if(accountMode==='dual'){
      const positions=rows(await this.client.privateFuturesGetSettleDualCompPositionsContract({settle:SETTLE,contract:market.id}));
      return (['dual_long','dual_short'] as Direction[]).map(side=>{
        const matches=positions.filter(p=>p.contract===market.id&&p.mode===side);
        if(matches.length!==1)throw new Error('gate: position margin mode is unverified');
        return parse(matches[0]);
      });
    }
    return Promise.all((['dual_long','dual_short'] as Direction[]).map(async dual_side=>{
      // Split accounts keep independent settings for each margin mode and direction.
      const result=await this.client.privateFuturesGetSettleGetLeverageContract({settle:SETTLE,contract:market.id,pos_margin_mode:entryMargin,dual_side});
      const value=numeric(result?.Lever);if(!(value>0&&Number.isFinite(value)))throw new Error('gate: position leverage is unverified');return {margin:entryMargin,leverage:value};
    }));
  }
  async assertTradingMode(_symbol:string):Promise<Mode>{
    const accountMode=this.assertAccount(await this.account());
    return accountMode;
  }
  async inspectTrading(symbol:string,leverage:number):Promise<void>{await this.inspect(symbol,leverage);}
  private async inspect(symbol:string,leverage:number):Promise<{mode:Mode;settings:{margin:Margin;leverage:number}[]}>{
    if(!(leverage>=1&&Number.isFinite(leverage)))throw new Error('gate: invalid requested leverage');
    const market=this.market(symbol);
    const minimum=numeric(market.limits?.leverage?.min??market.info?.leverage_min),maximum=numeric(market.limits?.leverage?.max??market.info?.leverage_max);
    if(minimum>0&&leverage<minimum||maximum>0&&leverage>maximum)throw new Error('gate: requested leverage is outside contract limits');
    const params={settle:SETTLE,contract:market.id,status:'open',limit:1};
    const [account,positions,open,conditional]=await Promise.all([this.account(),this.positions(),
      this.client.privateFuturesGetSettleOrders(params).then(rows),this.client.privateFuturesGetSettlePriceOrders(params).then(rows)]);
    const accountMode=this.assertAccount(account);
    if(this.active(positions).some(p=>p.contract===market.id)||open.length||conditional.length)throw new Error('gate: existing position or pending order prevents entry preparation');
    return {mode:accountMode,settings:await this.settings(symbol,accountMode)};
  }
  async prepare(symbol:string,leverage:number):Promise<void>{
    clientState(this.client).prepared.delete(symbol);
    const inspected=await this.inspect(symbol,leverage),accountMode=inspected.mode,market=this.market(symbol),margin=this.entryMargin;
    let settings=inspected.settings;
    // Switching only a verified empty contract avoids altering existing positions.
    // Split mode selects its independent margin slot on the order, so it needs no mode switch.
    if(accountMode!=='dual_plus'&&settings.some(setting=>setting.margin!==margin)){
      // Gate requires JSON for cross_mode. CCXT's positions POST heuristic otherwise
      // puts these fields in the query. With only the path parameter, sign() keeps
      // this explicit body and signs its SHA512 hash correctly.
      const path=accountMode==='single'?'{settle}/positions/cross_mode':'{settle}/dual_comp/positions/cross_mode';
      try{await this.client.request(path,['private','futures'],'POST',{settle:SETTLE},undefined,JSON.stringify({contract:market.id,mode:margin==='cross'?'CROSS':'ISOLATED'}));}
      catch(error){if(!(error&&typeof error==='object'&&'apiCode' in error&&error.apiCode==='NO_CHANGE'))throw error;}
      settings=await this.settings(symbol,accountMode);
      if(settings.some(setting=>setting.margin!==margin))throw new Error(`gate: requested ${margin} margin could not be verified`);
    }
    // Cross long/short share one leverage setting, including dual_plus. Gate's
    // dual_side is for isolated leverage only; passing it with cross is rejected.
    // https://www.gate.com/announcements/article/50954
    const setLeverage=async(dual_side?:Direction)=>{
      try{
        await this.client.privateFuturesPostSettlePositionsContractSetLeverage({settle:SETTLE,contract:market.id,margin_mode:margin,leverage:String(leverage),...(dual_side?{dual_side}:{})});
      }catch(error){
        // An exchange NO_CHANGE is only provisional; the fresh mode and complete leverage readback below must still pass.
        if(!(error&&typeof error==='object'&&'apiCode' in error&&error.apiCode==='NO_CHANGE'))throw error;
      }
    };
    if(margin==='isolated'&&accountMode!=='single'){
      for(const [index,dual_side] of (['dual_long','dual_short'] as const).entries())
        if(settings[index].leverage!==leverage)await setLeverage(dual_side);
    }else if(settings.some(setting=>setting.leverage!==leverage)){
      await setLeverage();
    }
    if(this.assertAccount(await this.account())!==accountMode||(await this.settings(symbol,accountMode)).some(value=>value.margin!==margin||value.leverage!==leverage))
      throw new Error('gate: requested leverage or unchanged position mode could not be verified');
    clientState(this.client).prepared.set(symbol,{mode:accountMode,leverage,margin});
  }
  async place(request:OrderRequest,contracts:number,price:number,canSubmit?:()=>boolean):Promise<string|undefined>{
    return this.placeNative(request,contracts,price,false,canSubmit);
  }
  /** Only the supervised reduction route may combine PostOnly and reduce-only. */
  async placeMakerReduction(request:OrderRequest,contracts:number,price:number,canSubmit?:()=>boolean):Promise<string|undefined>{
    assertMakerReductionRequest(request);
    return this.placeNative(request,contracts,price,true,canSubmit);
  }
  private async placeNative(request:OrderRequest,contracts:number,price:number,makerReduction=false,canSubmit?:()=>boolean):Promise<string|undefined>{
    if(!makerReduction&&request.postOnly&&(request.reduceOnly||request.closePosition))throw new OrderNotSubmittedError('gate: Maker trial can only open a position','INVALID_MAKER_ORDER','Maker 试运行仅用于入场首腿，不能用于平仓');
    const state=clientState(this.client),signature=JSON.stringify(request),previous=state.submitted.get(request.clientOrderId);
    if(previous){if(previous.request!==signature)throw new Error('gate: client order ID reused with different request');if(previous.rejection)throw previous.rejection;return previous.id;}
    if(request.closePosition&&!request.reduceOnly)throw new OrderNotSubmittedError('gate: close selector cannot open a position','INVALID_CLOSE_SELECTOR','精确分仓选择仅用于只减仓，本次未发送订单');
    const market=this.market(request.symbol);
    let accountMode:Mode,reductionPositions:PromiseSettledResult<any[]>|undefined;
    try{
      if(request.reduceOnly){
        // Mode and holdings are independent GETs. Drain both before deciding whether
        // the unchanged native target is safe; a failed read cannot leave a sibling
        // request running after this reduction has returned or enable a create.
        const [account,positions]=await Promise.allSettled([this.account(),this.positions()]);
        reductionPositions=positions;
        if(account.status==='rejected')throw account.reason;
        accountMode=this.assertAccount(account.value);
      }else accountMode=await this.assertTradingMode(request.symbol);
    }
    catch(error){
      if(!request.closePosition)throw error;
      throw new OrderNotSubmittedError('gate: exact close account read failed','CLOSE_POSITION_UNVERIFIED','Gate 账户模式读取失败，本次未发送平仓订单');
    }
    let margin:Margin=this.entryMargin;
    if(!request.reduceOnly){
      const prepared=state.prepared.get(request.symbol);
      if(!prepared)throw new Error('gate: opening order requires verified preparation');
      if(prepared.mode!==accountMode||(await this.settings(request.symbol,accountMode,prepared.margin)).some(value=>value.margin!==prepared.margin||value.leverage!==prepared.leverage))
        throw new Error('gate: requested leverage or unchanged position mode could not be verified');
      margin=prepared.margin;
    }
    const amount=numeric(this.client.amountToPrecision(request.symbol,contracts)),limit=numeric(this.client.priceToPrecision(request.symbol,price));
    if(market.base!==request.base||!(contracts>0&&Number.isFinite(contracts))||amount!==contracts||
      Math.abs(contracts*numeric(market.contractSize)-request.quantity)>Math.max(1e-12,request.quantity*1e-9)||
      !(limit>0)||request.side==='buy'&&limit>request.limitPrice||request.side==='sell'&&limit<request.limitPrice)
      throw new Error('gate: order quantity or limit exceeds requested bounds');
    let pid:string|undefined;
    if(request.reduceOnly){
      try{
        if(!reductionPositions)throw new Error('gate: close target read missing');
        if(reductionPositions.status==='rejected')throw reductionPositions.reason;
        ({margin,pid}=this.closeTarget(request,accountMode,reductionPositions.value,contracts));
      }
      catch(error){throw new OrderNotSubmittedError(error instanceof Error?error.message:'gate: close target read failed',
        'CLOSE_POSITION_CHANGED','Gate 待平分仓数量、身份或模式已变化，或账户读取失败；本次未发送订单，请刷新持仓');}
    }
    const payload={settle:SETTLE,contract:market.id,size:String(request.side==='buy'?contracts:-contracts),price:String(limit),tif:request.postOnly?'poc':'ioc',
      text:exchangeClientId('gate',request.clientOrderId),reduce_only:request.reduceOnly,
      ...(accountMode==='dual_plus'?{pos_margin_mode:margin}:{}),...(pid?{pid}:{})};
    // Shared by short-lived helper instances, so an unknown POST is never sent again within the same client session.
    const concurrent=state.submitted.get(request.clientOrderId);
    if(concurrent){if(concurrent.request!==signature)throw new Error('gate: client order ID reused with different request');if(concurrent.rejection)throw concurrent.rejection;return concurrent.id;}
    const submitted:Submission={request:signature,mode:accountMode,margin,limitPrice:limit,pid};state.submitted.set(request.clientOrderId,submitted);
    try{if(makerReduction)assertMakerReductionPermission(canSubmit);else assertOrderSubmissionPermission(canSubmit);}
    catch(error){submitted.rejection=error as OrderNotSubmittedError;throw error;}
    try{
      const result=await this.client.privateFuturesPostSettleOrders(payload);
      submitted.id=id(result?.id);return submitted.id;
    }catch(error){
      // https://www.gate.com/docs/developers/apiv4/en/#label-list
      if(makerReduction&&!submitted.id&&consumeGateMakerCreateRejection(error,this.client,request.clientOrderId)){
        submitted.rejection=new OrderNotSubmittedError('gate: original PostOnly create explicitly rejected','GATE_MAKER_POST_ONLY_WOULD_TAKE',
          'Gate PostOnly 委托会立即吃单，原创建请求已明确拒绝；本单未成交、未扣费');
        throw submitted.rejection;
      }
      throw error;
    }
  }
  async cancel(symbol:string,orderId:string):Promise<void>{
    this.market(symbol);if(!id(orderId))throw new Error('gate: cancellation requires an exact order ID');
    await this.client.privateFuturesDeleteSettleOrdersOrderId({settle:SETTLE,order_id:orderId});
  }
  /** Frozen facts of the actual native submission; no account reads or execution inference. */
  submissionIdentity(request:OrderRequest):{marginMode?:Margin;positionId?:string;limitPrice:number}|undefined{
    const saved=clientState(this.client).submitted.get(request.clientOrderId);
    if(!saved||saved.request!==JSON.stringify(request))return;
    return {...(saved.mode==='dual_plus'?{marginMode:saved.margin}:{}),...(saved.pid?{positionId:saved.pid}:{}),limitPrice:saved.limitPrice};
  }
  private async order(request:OrderRequest,orderId?:string):Promise<any>{
    const text=exchangeClientId('gate',request.clientOrderId),market=this.market(request.symbol);
    try{return await this.client.privateFuturesGetSettleOrdersOrderId({settle:SETTLE,order_id:orderId??text});}
    catch(error){
      if(orderId)throw error;
      const history=rows(await this.client.privateFuturesGetSettleOrders({settle:SETTLE,contract:market.id,status:'finished',limit:100}));
      const matched=history.filter(o=>o.text===text);
      if(matched.length!==1)throw new Error('gate: order outcome remains unknown');return matched[0];
    }
  }
  private normalize(raw:any,request:OrderRequest,prior:OrderResult,orderId?:string):OrderResult{
    const market=this.market(request.symbol),order=id(raw?.id),size=numeric(raw?.size),left=numeric(raw?.left),limit=numeric(raw?.price);
    const submitted=clientState(this.client).submitted.get(request.clientOrderId);
    const expectedId=orderId??(prior.id||undefined);
    if(!order||expectedId&&order!==expectedId||prior.id&&order!==prior.id||raw.contract!==market.id||raw.text!==exchangeClientId('gate',request.clientOrderId)||
      raw.tif!==(request.postOnly?'poc':'ioc')||raw.is_reduce_only!==request.reduceOnly||raw.is_close===true||raw.auto_size&&raw.auto_size!==''||
      !Number.isFinite(size)||!Number.isFinite(left)||size===0||(size>0)!==(request.side==='buy')||!(limit>0)||
      request.side==='buy'&&limit>request.limitPrice||request.side==='sell'&&limit<request.limitPrice||
      raw.pos_margin_mode!==undefined&&!['isolated','cross'].includes(raw.pos_margin_mode)||
      submitted&&raw.pos_margin_mode!==undefined&&raw.pos_margin_mode!==submitted.margin||
      submitted?.mode==='dual_plus'&&raw.pos_margin_mode!==submitted.margin||
      submitted?.pid!==undefined&&raw.pid!==undefined&&id(raw.pid)!==submitted.pid||
      request.closePosition?.positionId!==undefined&&raw.pid!==undefined&&id(raw.pid)!==request.closePosition.positionId||
      request.closePosition?.marginMode!==undefined&&raw.pos_margin_mode!==undefined&&raw.pos_margin_mode!==(request.closePosition.marginMode==='crossed'?'cross':'isolated'))throw new Error('gate: order identity or margin mode mismatch');
    const quantity=Math.abs(size)*numeric(market.contractSize),filledQuantity=(Math.abs(size)-Math.abs(left))*numeric(market.contractSize);
    const averagePrice=filledQuantity>0?numeric(raw.fill_price):0;
    const timestamp=[numeric(raw.finish_time_ms),numeric(raw.create_time_ms),numeric(raw.finish_time)*1000,numeric(raw.create_time)*1000].find(value=>value>0)??NaN;
    if(Math.abs(quantity-request.quantity)>Math.max(1e-12,request.quantity*1e-9)||filledQuantity<0||filledQuantity+1e-12<prior.filledQuantity||
      filledQuantity>request.quantity*(1+1e-9)||filledQuantity>0&&!(averagePrice>0)||!(timestamp>0))throw new Error('gate: inconsistent cumulative order execution');
    return {id:order,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity,averagePrice,feeUsd:prior.feeUsd,timestamp};
  }
  private async executionTotals(request:OrderRequest,result:OrderResult,makerLimitPrice?:number):Promise<{feeUsd:number;averagePrice:number}>{
    if(result.filledQuantity===0)return {feeUsd:0,averagePrice:0};
    const market=this.market(request.symbol),seen=new Map<string,string>();let quantity=0,feeUsd=0,valueUsd=0;
    for(let page=0;page<10;page++){
      const trades=rows(await this.client.privateFuturesGetSettleMyTrades({settle:SETTLE,contract:market.id,order:result.id,limit:100,offset:page*100}));
      for(const trade of trades){
        if(String(trade.order_id)!==result.id||trade.contract!==market.id)continue;
        const tradeId=id(trade.id),size=numeric(trade.size),price=numeric(trade.price),fee=numeric(trade.fee),pointFee=numeric(trade.point_fee);
        if(!tradeId||!Number.isFinite(size)||size===0||(size>0)!==(request.side==='buy')||!Number.isFinite(price)||price<=0||
          request.side==='buy'&&price>request.limitPrice||request.side==='sell'&&price<request.limitPrice||
          makerLimitPrice!==undefined&&(request.side==='buy'?price>makerLimitPrice:price<makerLimitPrice)||!Number.isFinite(fee)||pointFee!==0||
          trade.fee_currency!==undefined&&trade.fee_currency!=='USDT')throw new Error('gate: paid fees are incomplete or not denominated in USDT');
        // The native close_size distinguishes a pure close from opening or flipping a net position.
        // Older responses can omit it; an explicitly returned inconsistent action is never a verified fill.
        if(trade.close_size!==undefined){
          const closed=numeric(trade.close_size);
          if(!Number.isFinite(closed)||(request.reduceOnly?closed===0||(closed>0)!==(size>0)||Math.abs(closed)+1e-12<Math.abs(size):closed!==0))
            throw new Error('gate: native execution action does not match requested opening or reduction');
        }
        const signature=JSON.stringify([size,price,fee,pointFee]);
        if(seen.has(tradeId)){if(seen.get(tradeId)!==signature)throw new Error('gate: conflicting duplicate trade');continue;}
        const baseQuantity=Math.abs(size)*numeric(market.contractSize);
        seen.set(tradeId,signature);quantity+=baseQuantity;valueUsd+=baseQuantity*price;feeUsd+=fee;
      }
      // Gate's order fill_price is rounded. Only a complete, identity-checked trade set can replace it.
      if(Math.abs(quantity-result.filledQuantity)<=Math.max(1e-12,result.filledQuantity*1e-9))return {feeUsd,averagePrice:valueUsd/quantity};
      if(quantity>result.filledQuantity*(1+1e-9)||trades.length<100)break;
    }
    throw new Error('gate: paid fees do not cover confirmed fills');
  }
  async reconcile(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<OrderResult>{
    let confirmed=prior;
    try{
      orderId??=prior.id||undefined;
      let raw=await this.order(request,orderId),result=this.normalize(raw,request,prior,orderId);confirmed=result;
      if(raw.status==='open'){
        await this.cancel(request.symbol,result.id);
        raw=await this.order(request,result.id);result=this.normalize(raw,request,result,result.id);confirmed=result;
      }
      if(raw.status!=='finished')return result;
      const totals=await this.executionTotals(request,result);
      return {...result,...totals,status:result.filledQuantity>=request.quantity*(1-1e-9)?'filled':result.filledQuantity>0?'partial':'cancelled'};
    }catch{return {...confirmed,status:'unknown'};}
  }
  async inspectOrder(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<OrderResult>{
    let confirmed=prior;
    try{
      orderId??=prior.id||undefined;
      const raw=await this.order(request,orderId),result=this.normalize(raw,request,prior,orderId);confirmed=result;
      if(raw.status!=='finished')return result;
      const totals=await this.executionTotals(request,result);
      return {...result,...totals,...(result.filledQuantity>0?{averagePriceVerified:true}:{}),
        status:result.filledQuantity>=request.quantity*(1-1e-9)?'filled':result.filledQuantity>0?'partial':'cancelled'};
    }catch{return {...confirmed,status:'unknown'};}
  }
  /** No cancellation and no promotion of an active partial order into a terminal receipt. */
  async inspectMakerReduction(request:OrderRequest,prior=unknownOrder(request),orderId?:string):Promise<MakerReductionObservation>{
    assertMakerReductionRequest(request);
    try{
      orderId??=prior.id||undefined;
      const raw=await this.order(request,orderId),result=this.normalize(raw,request,prior,orderId);
      if(!['open','finished'].includes(raw.status))throw new Error('gate: Maker reduction activity is unverified');
      const totals=await this.executionTotals(request,result,numeric(raw.price));
      const observation=verifiedMakerReduction(request,{...result,...totals},raw.status==='open'?'active':'terminal');
      // Futures finish_as has no PostOnly liquidity enum; poc is only a tif value.
      // https://www.gate.com/docs/developers/apiv4/en/futures/#query-single-order-details
      if(request.postOnly&&observation.activity==='terminal'&&observation.executionVerified&&
        !(raw.finish_as==='cancelled'||raw.finish_as==='filled'&&observation.result.status==='filled'))
        observation.result={...observation.result,rejectionCode:'MAKER_REDUCTION_FINISH_REASON_BLOCKED',
          rejectionReason:'Gate Maker 原订单已结束，但结束原因不允许自动重挂；保留已确认成交和费用，等待核对'};
      return observation;
    }catch{return unknownMakerReduction(prior);}
  }
}

export function gateReadError(error:unknown):string|undefined{
  if(!(error instanceof Error))return undefined;
  const messages:Record<string,string>={
    'gate: account position mode is unverified':'Gate 持仓模式无法确认，请重新检查账户连接',
    'gate: inconsistent account position mode':'Gate 返回的持仓模式信息不一致，暂不能执行',
    'gate: unsupported portfolio or multi-currency margin account':'Gate 当前组合保证金或多币种保证金模式尚未支持执行',
    'gate: incomplete USDT futures balances':'Gate USDT 合约余额字段不完整，请重新检查连接',
    'gate: unified account equity is unavailable':'Gate 统一账户未返回有效总权益，已保留未读取状态',
    'gate: multiple positions for the same contract side require manual reconciliation':'Gate 同一币种方向存在多个仓位，需要人工核对后再执行',
    'gate: split position ID is unverified':'Gate 分仓编号无法确认，暂不能操作该仓位',
    'gate: existing position or pending order prevents entry preparation':'Gate 该合约已有仓位或挂单，不能准备新开仓',
    'gate: position margin mode is unverified':'Gate 该合约的保证金模式无法确认',
    'gate: position leverage is unverified':'Gate 未能读取该合约杠杆设置',
    'gate: requested leverage is outside contract limits':'Gate 请求杠杆超出该合约支持的范围，请调整杠杆设置',
    'gate: requested cross margin could not be verified':'Gate 该合约的全仓模式未通过读回确认',
    'gate: requested isolated margin could not be verified':'Gate 该合约的逐仓模式未通过读回确认',
    'gate: requested leverage or unchanged position mode could not be verified':'Gate 杠杆设置未通过读回确认，或持仓模式已变化',
    'gate: exact position for quantitative close is unavailable or ambiguous':'Gate 未找到可唯一确认的仓位，不能执行定量平仓',
  };
  return messages[error.message];
}
