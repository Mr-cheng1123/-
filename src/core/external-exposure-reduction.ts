import {randomUUID} from 'node:crypto';
import type {AccountPosition,AccountState,AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,OrderResult,Position} from '../shared/types.js';
import type {Store} from './store.js';
import {Execution} from './execution.js';
import {planBestPriceReduction} from './close-batch.js';
import {quoteIsFresh} from './market-validity.js';
import {isCurrentUnconfirmedOrder,isPositionActive} from '../shared/ledger-lifecycle.js';
import {quantityAdd,quantitySubtract,isQuantityOnStep} from './order-quantity.js';
import {verifyCloseSlots} from './scoped-manual-close.js';
import {isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';
import {conflictingNativeOrderReceipts,isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';

export interface ExternalExposureReductionAudit {
  version:1;sourcePositionId:string;sourceOpenedAt:number;authorizedAt:number;
  side:'long'|'short';exchange:ExchangeId;symbol:string;initialExcessQuantity:number;
  initialNativeQuantity:number;peerInitialQuantity:number;
  nativeIdentity:string;peerIdentity?:string;
}
export type ExternalExposureReduction=ExternalExposureReductionAudit;
export interface ExternalExposureReductionOptions {
  store:Store;source:Position;config:AppConfig;adapter:(exchange:ExchangeId)=>ExchangeAdapter;
  readAccount:(exchange:ExchangeId)=>Promise<{account:AccountState;startedAt:number}>;
  read:<T>(adapter:ExchangeAdapter,key:string,call:()=>Promise<T>)=>Promise<T>;
  snapshot:(exchange:string,base:string)=>MarketSnapshot|undefined;
  refreshBooks:(base:string,exchanges:string[])=>Promise<void>;
  ensure:()=>void;onFinancialActivity:(journal?:JournalOrder)=>void;
  serialize:<T>(work:()=>Promise<T>)=>Promise<T>;
}
export interface ExternalExposureReductionResult {
  status:'waiting'|'submitted'|'closed';reason:string;riskPositionId?:string;quantity?:number;result?:OrderResult;
}
const EPS=(q:number)=>Number.EPSILON*Math.max(1,Math.abs(q))*16;
const same=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(EPS(a),EPS(b));
const identity=(row:AccountPosition)=>JSON.stringify([row.symbol,row.side,row.marginMode??null,row.positionId??null,
  row.positionOpenedAt??null,row.entryPrice??null,row.splitPositionCount??1]);
const financial=(p:Position)=>({...p,holdDecision:undefined,riskReasons:undefined,spreadPnlUsd:undefined,netPnlUsd:undefined,
  deltaUsd:undefined,estimatedFeeRebateUsd:undefined,estimatedNetPnlAfterRebateUsd:undefined,operationProgress:undefined,
  long:{...p.long,markPrice:undefined,liquidationDistancePct:undefined,fundingObservedAt:undefined,fundingObservedSince:undefined},
  short:{...p.short,markPrice:undefined,liquidationDistancePct:undefined,fundingObservedAt:undefined,fundingObservedSince:undefined}});

/** One independent IOC, authorized only by this invocation's stable native excess.
 * Original source quantities/cash are never changed to explain external fills. */
export async function runExternalExposureReduction(o:ExternalExposureReductionOptions):Promise<ExternalExposureReductionResult>{
  const {source,store,config}=o,started=Date.now(),deadline=started+8000;
  const wait=(reason:string,riskPositionId?:string):ExternalExposureReductionResult=>({status:'waiting',reason,...(riskPositionId?{riskPositionId}:{})});
  const children=store.data.positions.filter(p=>p.manualCloseSourcePositionId===source.id&&p.externalExposureReduction);
  if(children.length>1)return wait('原币种存在多个独立风险记录，等待核验');
  let risk=children[0];
  const completed=!!risk&&(!!risk.accountClosure||risk.status==='closed');
  if(risk&&(!risk.manualCloseOnly||!risk.manualCloseAccountRecord||risk.base!==source.base||risk.mode!=='live'||
    store.data.orders.some(order=>order.positionId===risk!.id&&isUnconfirmedJournalOrder(order))))
    return wait('独立风险记录或原生回执尚未完整核实，禁止扩大授权',risk.id);
  const sameCoin=(order:JournalOrder)=>!order.request||!order.request.base||!order.request.symbol||
    order.request.base===source.base||[source.long,source.short].some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol);
  const samePosition=(p:Position)=>p.base===source.base||[p.long,p.short].some(other=>[source.long,source.short]
    .some(leg=>leg.exchange===other.exchange&&leg.symbol===other.symbol));
  const unknown=(own?:JournalOrder)=>store.data.orders.some(order=>order!==own&&sameCoin(order)&&isCurrentUnconfirmedOrder(order,store.data.positions));
  const scope=(own?:JournalOrder)=>JSON.stringify({config,source:financial(source),
    orders:store.data.orders.filter(order=>order!==own&&sameCoin(order)),
    siblings:store.data.positions.filter(p=>p!==source&&p!==risk&&samePosition(p)).map(financial),risk:risk?financial(risk):undefined});
  const originalScope=scope();
  const check=()=>{o.ensure();if(store.data.config!==config||config.mode!=='live'||store.data.killSwitch||!store.data.positions.includes(source)||
    source.mode!=='live'||!isPositionActive(source)||source.manualCloseOnly||source.manualCloseAccountRecord||
    source.long.exchange===source.short.exchange||source.long.side!=='long'||source.short.side!=='short'||
    !source.base||!source.long.symbol||!source.short.symbol||!Number.isFinite(source.openedAt)||source.openedAt<=0||
    store.data.positions.some(p=>p!==source&&p!==risk&&samePosition(p)&&isPositionActive(p))||
    !same(source.long.quantity,source.short.quantity)||source.long.quantity<=0||unknown())throw new Error('外部敞口风险范围或原订单尚未核实');};
  try{check();}catch{return wait('原持仓、权限或同币未确认订单不满足独立风险减仓守卫',risk?.id);}
  const rowsFor=(account:AccountState,side:'long'|'short'):AccountPosition|undefined=>{
    const leg=source[side],matched=account.positions.filter(row=>row.symbol===leg.symbol||row.base===source.base);
    if(matched.some(row=>!Number.isFinite(row.quantity)||row.quantity<0))throw new Error('原生仓位数量不完整');
    const rows=matched.filter(row=>row.quantity>0);
    if(!rows.length)return;
    const row=rows[0];
    if(rows.length!==1||row.symbol!==leg.symbol||row.base!==source.base||row.side!==side||!Number.isFinite(row.quantity)||
      row.quantity<=0||row.quantity>leg.quantity+EPS(leg.quantity)||(row.splitPositionCount??1)!==1||
      !['crossed','isolated'].includes(row.marginMode??'')||!Number.isFinite(row.entryPrice)||row.entryPrice!<=0||
      !Number.isFinite(row.positionOpenedAt)||row.positionOpenedAt!<source.openedAt-5000||
      row.positionOpenedAt!>Math.max(source.openedAt,...store.data.orders.filter(order=>order.positionId===source.id&&!order.request.reduceOnly)
        .map(order=>Math.max(order.createdAt,order.result?.timestamp??0)))+5000)
      throw new Error('原生仓位身份、周期、方向、数量或分仓不明确');
    // A native adapter may reuse its account object on the next read. Freeze the
    // first round's identity and quantity rather than comparing two live aliases.
    return {...row};
  };
  const round=async()=>{
    const begin=Date.now(),settled=await Promise.allSettled([source.long.exchange,source.short.exchange].map(exchange=>o.readAccount(exchange)));
    for(const read of settled)if(read.status==='rejected')throw read.reason;
    const reads=settled.map(read=>(read as PromiseFulfilledResult<{account:AccountState;startedAt:number}>).value);
    if(reads.some(read=>!Number.isFinite(read.startedAt)||read.startedAt<begin||read.startedAt>Date.now()||Date.now()-read.startedAt>8000||
      !Array.isArray(read.account.positions)||!Number.isFinite(read.account.equityUsd)))throw new Error('双腿账户读取不属于本轮新鲜完整证明');
    check();if(scope()!==originalScope)throw new Error('原风险现金范围在读取期间变化');
    return {long:rowsFor(reads[0].account,'long'),short:rowsFor(reads[1].account,'short')};
  };
  let first:Awaited<ReturnType<typeof round>>,last:Awaited<ReturnType<typeof round>>;
  try{
    first=await round();
    const open=await Promise.allSettled([source.long,source.short].map(async leg=>{
      const adapter=o.adapter(leg.exchange);if(!adapter.fetchOpenOrders)throw new Error('缺少完整原生挂单读取');
      const rows=await o.read(adapter,`external-risk-orders:${source.id}:${leg.symbol}`,()=>adapter.fetchOpenOrders!(leg.symbol,{deadlineAt:deadline}));
      if(!Array.isArray(rows)||rows.length)throw new Error('原币种仍有普通或条件挂单');
    }));
    for(const orders of open)if(orders.status==='rejected')throw orders.reason;
    last=await round();
    const key=(proof:typeof first)=>JSON.stringify(['long','short'].map(side=>{const row=proof[side as 'long'|'short'];return row?[identity(row),row.quantity]:null;}));
    if(key(first)!==key(last)||Date.now()>=deadline||scope()!==originalScope)throw new Error('原生两轮证明不稳定或已经过期');
  }catch{return wait('双轮原生账户、挂单或原现金证明暂不可用；未提交风险减仓',risk?.id);}
  const longQuantity=last.long?.quantity??0,shortQuantity=last.short?.quantity??0;
  if(!last.long&&!last.short){
    if(!risk)return {status:'closed',reason:'双轮完整原生证明实际双腿均已空仓，无新增风险减仓；保留原策略现金和数量'};
    await o.serialize(async()=>{check();if(scope()!==originalScope||Date.now()>=deadline||Date.now()<started)throw new Error('风险空仓证明期间现金变化或证明已过期');
      risk!.accountClosure={confirmedAt:Date.now(),reason:'独立风险记录对应实际双腿已空仓；未消费数量与外部现金不推定成交',historicalOrdersPending:false};
      risk!.status='closed';try{store.save();}catch(error){store.data.killSwitch=true;throw error;}});
    return {status:'closed',reason:'独立风险记录已取得双腿真实空仓证明，保留原未消费账本',riskPositionId:risk.id};
  }
  if(same(longQuantity,shortQuantity))return {status:'closed',
    reason:'双轮原生证明实际双腿已同量，风险消除；保留原账本及已有独立记录未消费预算',...(risk?{riskPositionId:risk.id}:{})};
  if(completed)return wait('原独立风险预算已结束，当前实际敞口仍需独立核验；未扩大授权',risk!.id);
  const side=longQuantity>shortQuantity?'long':'short',row=last[side]!,peer=last[side==='long'?'short':'long'];
  const excess=Math.abs(quantitySubtract(longQuantity,shortQuantity));
  if(risk){
    const audit=risk.externalExposureReduction!;
    const own=store.data.orders.filter(order=>order.positionId===risk!.id),filled=own.reduce((sum,order)=>quantityAdd(sum,order.result?.filledQuantity??0),0);
    if(audit.version!==1||audit.side!==side||audit.exchange!==source[side].exchange||audit.symbol!==source[side].symbol||
      !Number.isFinite(audit.initialExcessQuantity)||audit.initialExcessQuantity<=0||!Number.isFinite(audit.initialNativeQuantity)||
      !Number.isFinite(audit.peerInitialQuantity)||audit.peerInitialQuantity<0||
      audit.sourcePositionId!==source.id||audit.sourceOpenedAt!==source.openedAt||audit.nativeIdentity!==identity(row)||
      peer&&(audit.peerIdentity!==identity(peer)||peer.quantity>audit.peerInitialQuantity+EPS(peer.quantity))||
      conflictingNativeOrderReceipts(store.data.orders.filter(sameCoin)).size||own.some(order=>order.exchange!==audit.exchange||order.request.symbol!==audit.symbol||
        order.request.base!==source.base||!order.request.reduceOnly||order.request.postOnly===true||
        order.request.side!==(side==='long'?'sell':'buy')||order.executionEvidence?.method!=='ioc'||!order.result||
        !isTerminalOrderReceipt(order.request,order.result)||!Number.isFinite(order.result.feeUsd)||
        !same(order.executionEvidence.bookedFeeUsd??NaN,order.result.feeUsd))||
      row.quantity>audit.initialNativeQuantity-filled+EPS(row.quantity)||risk[side].symbol!==audit.symbol||risk[side].exchange!==audit.exchange||
      risk[side==='long'?'short':'long'].quantity!==0||
      !same(risk[side].quantity,audit.initialExcessQuantity-filled))return wait('原风险身份或固定剩余预算已变化，未扩大授权',risk.id);
  }
  const budget=risk?risk[side].quantity:excess;
  if(!(budget>0))return wait('原独立风险预算已消费，未新增授权',risk?.id);
  const leg=source[side];let book=o.snapshot(leg.exchange,source.base);
  try{if(!quoteIsFresh(book,config)||book?.symbol!==leg.symbol)await o.refreshBooks(source.base,[leg.exchange]);}
  catch{return wait('剩余风险腿盘口暂不可用，等待新鲜对手价1',risk?.id);}
  book=o.snapshot(leg.exchange,source.base);
  if(!book||book.symbol!==leg.symbol||book.exchange!==leg.exchange||book.base!==source.base||!quoteIsFresh(book,config)||
    Date.now()>=deadline||scope()!==originalScope)return wait('风险减仓盘口或双轮证明已过期',risk?.id);
  const plan=planBestPriceReduction(book,side,Math.min(excess,budget));
  if(!plan||!isQuantityOnStep(plan.quantity,book.quantityStep))return wait('实际风险尾差不足一个合法首档批次',risk?.id);
  let selector:AccountPosition|undefined=row;
  if(leg.exchange==='gate'){
    try{const adapter=o.adapter(leg.exchange);if(!adapter.fetchClosePositions)throw new Error('缺少原生分仓读取');
      const slots=await o.read(adapter,`external-risk-slots:${source.id}`,()=>adapter.fetchClosePositions!(leg.symbol));
      const verified=verifyCloseSlots(row,slots);if(verified.length!==1)throw new Error('原生风险分仓不唯一');selector=verified[0];
    }catch{return wait('Gate风险原生分仓身份尚未完整核验',risk?.id);}
  }
  if(Date.now()>=deadline||scope()!==originalScope)return wait('最终风险原生证明已经过期',risk?.id);
  if(!risk)await o.serialize(async()=>{
    check();if(scope()!==originalScope)throw new Error('新增独立风险记录前原现金范围变化');
    const audit:ExternalExposureReductionAudit={version:1,sourcePositionId:source.id,sourceOpenedAt:source.openedAt,authorizedAt:Date.now(),
      side,exchange:leg.exchange,symbol:leg.symbol,initialExcessQuantity:excess,initialNativeQuantity:row.quantity,
      peerInitialQuantity:peer?.quantity??0,nativeIdentity:identity(row),...(peer?{peerIdentity:identity(peer)}:{})};
    const riskLeg=(label:'long'|'short')=>({...source[label],quantity:label===side?excess:0,entryPrice:label===side?row.entryPrice!:0,
      feesUsd:0,fundingUsd:0,realizedPnlUsd:0,markPrice:label===side?row.markPrice:0,liquidationDistancePct:null});
    risk={id:randomUUID(),base:source.base,mode:'live',status:'closing',openedAt:Date.now(),plannedExitAt:Date.now(),holdMode:'once',
      long:riskLeg('long'),short:riskLeg('short'),manualCloseOnly:true,manualCloseAccountRecord:true,manualCloseSourcePositionId:source.id,
      externalExposureReduction:audit,fundingUsd:0,feesUsd:0,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,
      fundingEvents:[],riskReasons:['独立外部敞口风险减仓，不沿用盈利10bps门槛'],closeReason:'双轮原生确认外部减仓后的独立风险只减仓'};
    store.data.positions.push(risk);try{store.save();}catch(error){store.data.killSwitch=true;throw error;}
  });
  const riskScope=scope(),frozenRequest=new Map<JournalOrder,string>();
  const allowed=(own?:JournalOrder)=>{
    try{
      o.ensure();const current=o.snapshot(leg.exchange,source.base);
      if(store.data.config!==config||config.mode!=='live'||store.data.killSwitch||Date.now()>=deadline||Date.now()<started||!risk||!store.data.positions.includes(risk)||
        scope(own)!==riskScope||unknown(own)||!quoteIsFresh(current,config)||current.symbol!==leg.symbol||
        plan.quantity>Math.min(excess,risk[side].quantity)+EPS(plan.quantity))return false;
      if(own){
        const request=own.request;
        if(own.positionId!==risk.id||own.exchange!==leg.exchange||!store.data.orders.includes(own)||request.base!==source.base||request.symbol!==leg.symbol||
          request.reduceOnly!==true||request.postOnly===true||request.side!==(side==='long'?'sell':'buy')||!same(request.quantity,plan.quantity)||
          request.limitPrice!==plan.limitPrice)return false;
        const signature=JSON.stringify(request),prior=frozenRequest.get(own);
        if(prior!==undefined&&prior!==signature)return false;frozenRequest.set(own,signature);
      }
      return true;
    }catch{return false;}
  };
  const execution=new Execution(store,{config:()=>config,snapshot:(exchange,base)=>o.snapshot(exchange,base),adapter:exchange=>o.adapter(exchange as ExchangeId),
    liveUnlocked:()=>{try{o.ensure();return !store.data.killSwitch;}catch{return false;}},serialize:o.serialize,makerFinancialActivity:o.onFinancialActivity,
    prepareReduction:(_leg,quantity)=>({quantity,...(leg.exchange==='gate'?{closePosition:{side,marginMode:selector!.marginMode,
      positionId:selector!.positionId,positionOpenedAt:selector!.positionOpenedAt}}:{})}),halt:()=>{store.data.killSwitch=true;}});
  const result=await execution.reduceExternalRisk(risk!,risk![side],plan.quantity,allowed);
  return {status:'submitted',reason:'已记录独立原生风险IOC，只消费本轮真实额外敞口预算',riskPositionId:risk!.id,quantity:plan.quantity,result};
}
