import type {AccountPosition,LivePortfolio,Position,TradingFeeMetadata} from '../../src/shared/types';
import {isFreshPortfolioExchange,observeLedgerPosition,type PositionObservation} from './position-observation';
import {accountPositionMatchesLeg} from './account-position-identity';

export interface ObservedLedgerLeg extends Partial<TradingFeeMetadata> {
  quantity?:number;
  /** Quantity-weighted current native entry prices; never filled from historical orders. */
  entryPrice?:number;
  markPrice?:number;
  unrealizedPnlUsd?:number;
  realizedPnlUsd?:number;
  fundingUsd?:number;
  feesUsd?:number;
  cashFlowStatus?:AccountPosition['cashFlowStatus'];cashFlowReason?:string;cashFlowAt?:number;
  observedAt?:number;
  liquidation:{status:'unknown'|'flat'|'not_reported'|'not_liquidatable'|'available';distancePct?:number;reason?:string};
  cycleMismatch?:boolean;
}
export interface LedgerPositionMetrics {
  observation:PositionObservation;
  source:'account'|'ledger';
  long:ObservedLedgerLeg;
  short:ObservedLedgerLeg;
  holding:'unknown'|'flat'|'paired'|'imbalanced'|'single'|'other_contract'|'historical';
  unrealizedPnlUsd?:number;
  realizedPnlUsd?:number;
  fundingUsd?:number;
  feesUsd?:number;
  netPnlUsd?:number;
  observedSubtotalUsd?:number;
  deltaUsd?:number;
  deltaQuantity?:number;
  observedAt?:number;
  cycleMismatch?:boolean;
  ledgerQuantitiesMatch?:boolean;
}
const sumComplete=(values:Array<number|undefined>)=>values.every(value=>Number.isFinite(value))?
  values.reduce<number>((sum,value)=>sum+value!,0):undefined;
const sumRows=(rows:AccountPosition[],field:'unrealizedPnlUsd'|'realizedPnlUsd'|'fundingUsd'|'feesUsd')=>sumComplete(rows.map(row=>row[field]));
const sameQuantity=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-10,Math.max(a,b)*1e-8);

export function accountPositionLiquidation(row:AccountPosition):ObservedLedgerLeg['liquidation'] {
  if(row.quantity<=0)return {status:'flat'};
  if(row.markPrice>0&&Number.isFinite(row.liquidationPrice)&&row.liquidationPrice>0)return {status:'available',
    distancePct:(row.side==='long'?row.markPrice-row.liquidationPrice:row.liquidationPrice-row.markPrice)/row.markPrice*100};
  return {status:row.liquidationStatus==='not_liquidatable'?'not_liquidatable':'not_reported',reason:row.liquidationReason};
}

/** Current metrics are an account observation. Historical fills never replace a missing account read. */
export function ledgerPositionMetrics(position:Position,portfolio:LivePortfolio|undefined,now=Date.now()):LedgerPositionMetrics {
  const observation=observeLedgerPosition(position,portfolio,now);
  if(position.mode!=='live'||position.status==='closed'){
    const leg=(side:'long'|'short'):ObservedLedgerLeg=>({quantity:position[side].quantity,entryPrice:position[side].entryPrice,markPrice:position[side].markPrice,
      liquidation:position[side].quantity<=0?{status:'flat'}:position[side].liquidationDistancePct===null?
        {status:'not_reported'}:{status:'available',distancePct:position[side].liquidationDistancePct!}});
    return {observation,source:'ledger',long:leg('long'),short:leg('short'),holding:position.status==='closed'?'historical':'paired',
      unrealizedPnlUsd:position.spreadPnlUsd,fundingUsd:position.fundingUsd,feesUsd:position.feesUsd,
      netPnlUsd:position.netPnlUsd,deltaUsd:position.deltaUsd};
  }
  const lastActivity=Math.max(position.openedAt,position.closeRequestedAt??0,position.closeAttemptedAt??0);
  const leg=(side:'long'|'short'):ObservedLedgerLeg=>{
    if(position.accountClosure||!portfolio)return {liquidation:{status:'unknown'}};
    const contract=position[side],account=portfolio.exchanges.find(item=>item.exchange===contract.exchange);
    if(!isFreshPortfolioExchange(account,portfolio,now)||account.requestedAt!<lastActivity)return {liquidation:{status:'unknown'}};
    // A different side or symbol with the same ticker does not establish this leg's quantity or PnL.
    const rows=account.positions.filter(row=>accountPositionMatchesLeg(account.exchange,row,contract)&&row.quantity>0);
    const quantity=rows.reduce((sum,row)=>sum+row.quantity,0),observedAt=account.receivedAt??account.requestedAt;
    if(quantity===0){
      // A flat account proves zero current quantity and UPL, not zero historical cash for a previously opened leg.
      const neverOpened=contract.quantity===0&&contract.entryPrice===0&&contract.feesUsd===0&&
        (contract.fundingUsd===undefined||contract.fundingUsd===0)&&(contract.realizedPnlUsd===undefined||contract.realizedPnlUsd===0);
      return {quantity:0,unrealizedPnlUsd:0,observedAt,liquidation:{status:'flat'},
        ...(neverOpened?{realizedPnlUsd:0,fundingUsd:0,feesUsd:0}:{})};
    }
    const validMarks=rows.every(row=>Number.isFinite(row.markPrice)&&row.markPrice>0),markPrice=validMarks?
      rows.reduce((sum,row)=>sum+row.markPrice*row.quantity,0)/quantity:undefined;
    const validEntries=rows.every(row=>Number.isFinite(row.entryPrice)&&row.entryPrice!>0),entryPrice=validEntries?
      rows.length===1?rows[0].entryPrice:rows.reduce((sum,row)=>sum+row.entryPrice!*row.quantity,0)/quantity:undefined;
    const distances=rows.map(row=>accountPositionLiquidation(row).distancePct);
    const liquidation=distances.every(distance=>Number.isFinite(distance))?
      {status:'available' as const,distancePct:Math.min(...distances as number[])}:
      rows.every(row=>row.liquidationStatus==='not_liquidatable')?
        {status:'not_liquidatable' as const,reason:rows.find(row=>row.liquidationReason)?.liquidationReason}:
        {status:'not_reported' as const,reason:rows.find(row=>row.liquidationReason)?.liquidationReason};
    const cycleMismatch=rows.some(row=>Number.isFinite(row.positionOpenedAt)&&
      Math.abs(row.positionOpenedAt!-position.openedAt)>60000)||
      !position.id.startsWith('account-display:')&&rows.some(row=>(row.splitPositionCount??0)>1&&!Number.isFinite(row.positionOpenedAt));
    const nativeFee=rows.every(row=>row.takerFeeSource==='exchange'&&Number.isFinite(row.takerFeeRate)&&
      Number.isFinite(row.takerFeeAt))&&new Set(rows.map(row=>row.takerFeeRate)).size===1?
      {takerFeeRate:rows[0].takerFeeRate!,takerFeeAt:Math.min(...rows.map(row=>row.takerFeeAt!)),takerFeeSource:'exchange' as const}:{};
    const cashRow=['error','unavailable','incomplete','stale','loading','ready']
      .map(status=>rows.find(row=>row.cashFlowStatus===status)).find(Boolean);
    const cashFlowAt=rows.every(row=>Number.isFinite(row.cashFlowAt)&&row.cashFlowAt!>0)?
      Math.min(...rows.map(row=>row.cashFlowAt!)):undefined;
    return {quantity,entryPrice,markPrice,observedAt,unrealizedPnlUsd:sumRows(rows,'unrealizedPnlUsd'),
      realizedPnlUsd:sumRows(rows,'realizedPnlUsd'),fundingUsd:sumRows(rows,'fundingUsd'),feesUsd:sumRows(rows,'feesUsd'),liquidation,cycleMismatch,
      ...(cashRow?{cashFlowStatus:cashRow.cashFlowStatus,cashFlowReason:cashRow.cashFlowReason}:{}),
      ...(cashFlowAt===undefined?{}:{cashFlowAt}),...nativeFee};
  };
  const long=leg('long'),short=leg('short'),bothKnown=long.quantity!==undefined&&short.quantity!==undefined;
  const holding:LedgerPositionMetrics['holding']=observation.status==='account_flat'?'flat':!bothKnown?'unknown':
    long.quantity!>0&&short.quantity!>0?(sameQuantity(long.quantity!,short.quantity!)?'paired':'imbalanced'):
      long.quantity!>0||short.quantity!>0?'single':'other_contract';
  const data:LedgerPositionMetrics={observation,source:'account',long,short,holding};
  data.cycleMismatch=long.cycleMismatch===true||short.cycleMismatch===true;
  if(bothKnown)data.ledgerQuantitiesMatch=sameQuantity(long.quantity!,position.long.quantity)&&sameQuantity(short.quantity!,position.short.quantity);
  if(long.observedAt&&short.observedAt)data.observedAt=Math.min(long.observedAt,short.observedAt);
  if(['flat','unknown','other_contract'].includes(holding))return data;
  data.unrealizedPnlUsd=sumComplete([long.unrealizedPnlUsd,short.unrealizedPnlUsd]);
  data.realizedPnlUsd=sumComplete([long.realizedPnlUsd,short.realizedPnlUsd]);
  data.fundingUsd=sumComplete([long.fundingUsd,short.fundingUsd]);
  data.feesUsd=sumComplete([long.feesUsd,short.feesUsd]);
  if([data.unrealizedPnlUsd,data.fundingUsd,data.feesUsd].every(value=>Number.isFinite(value)))
    data.observedSubtotalUsd=data.unrealizedPnlUsd!+data.fundingUsd!-data.feesUsd!;
  if(Number.isFinite(data.observedSubtotalUsd)&&Number.isFinite(data.realizedPnlUsd))
    data.netPnlUsd=data.observedSubtotalUsd!+data.realizedPnlUsd!;
  data.deltaQuantity=long.quantity!-short.quantity!;
  const marks=[long,short].filter(item=>item.quantity!>0).map(item=>item.markPrice);
  // Equal coin quantities have no directional delta even when the two venue marks differ.
  if(marks.length&&marks.every(value=>Number.isFinite(value)&&value!>0))
    data.deltaUsd=Math.abs(data.deltaQuantity)*marks.reduce<number>((sum,value)=>sum+value!,0)/marks.length;
  return data;
}

export function liquidationObservationLabel(leg:ObservedLedgerLeg):string {
  switch(leg.liquidation.status){
    case 'flat':return '无仓位';
    case 'unknown':return '待读取';
    case 'not_reported':return leg.liquidation.reason??'交易所未返回强平价';
    case 'not_liquidatable':return leg.liquidation.reason??'账户无单仓强平价';
    case 'available':return `${leg.liquidation.distancePct!.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}%`;
  }
}
