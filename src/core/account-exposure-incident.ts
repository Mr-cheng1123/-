import {createHash} from 'node:crypto';
import type {AccountState,ExchangeId,Position} from '../shared/types.js';

export interface AccountExposureIncident {
  version:1;id:string;status:'detected';positionId:string;base:string;openedAt:number;
  detectedAt:number;accountReadStartedAt:number;lastFinancialActivityAt:number;
  observedExchange:ExchangeId;symbol:string;side:'long'|'short';expectedQuantity:number;
  nativeQuantity:number|null;reason:'missing'|'quantity'|'opposite'|'ambiguous';
  nativeRows:Array<{side:'long'|'short';quantity:number;positionId?:string;positionOpenedAt?:number}>;
  originalLegs:Array<{exchange:ExchangeId;symbol:string;side:'long'|'short';quantity:number;entryPrice:number}>;
  pausedNewEntry:true;
}
export interface AccountExposureObservation {
  position:Position;exchange:ExchangeId;account:AccountState;now:number;readStartedAt:number;
  maxAgeMs:number;lastFinancialActivityAt:number;quantityTolerance:number;
  sourceCurrent:boolean;sessionAuthorized:boolean;executionBusy:boolean;unconfirmed:boolean;
}

/** One fresh accepted account anomaly is a diagnostic, never an order, cash update or reduction budget. */
export function accountExposureIncident(input:AccountExposureObservation):AccountExposureIncident|undefined {
  const {position:p,exchange,account,now,readStartedAt,maxAgeMs,lastFinancialActivityAt,quantityTolerance}=input;
  if(!input.sourceCurrent||!input.sessionAuthorized||input.executionBusy||input.unconfirmed||
    p.mode!=='live'||p.status!=='open'||p.accountClosure||p.manualCloseOnly||p.manualCloseAccountRecord||
    ![now,readStartedAt,maxAgeMs,lastFinancialActivityAt,quantityTolerance].every(Number.isFinite)||
    maxAgeMs<=0||quantityTolerance<0||readStartedAt<=lastFinancialActivityAt||readStartedAt>now||now-readStartedAt>maxAgeMs||
    !Array.isArray(account.positions))return;
  const leg=[p.long,p.short].find(value=>value.exchange===exchange&&value.quantity>0);
  if(!leg||!Number.isFinite(leg.quantity)||!Number.isFinite(p.openedAt)||p.openedAt<=0)return;
  const matching=account.positions.filter(row=>row.symbol===leg.symbol);
  if(matching.some(row=>!['long','short'].includes(row.side)||!Number.isFinite(row.quantity)||row.quantity<0))return;
  const rows=matching.filter(row=>row.quantity>0),same=rows.filter(row=>row.side===leg.side),opposite=rows.filter(row=>row.side!==leg.side);
  const nativeQuantity=same.length>1?null:same[0]?.quantity??0;
  const reason=opposite.length?'opposite':same.length>1?'ambiguous':!same.length?'missing':
    Math.abs(nativeQuantity!-leg.quantity)>quantityTolerance?'quantity':undefined;
  if(!reason)return;
  const nativeRows=rows.map(row=>({side:row.side,quantity:row.quantity,
    ...(typeof row.positionId==='string'?{positionId:row.positionId}:{}),
    ...(Number.isFinite(row.positionOpenedAt)&&row.positionOpenedAt!>0?{positionOpenedAt:row.positionOpenedAt}:{})}))
    .sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const originalLegs=[p.long,p.short].map(value=>({exchange:value.exchange,symbol:value.symbol,side:value.side,quantity:value.quantity,entryPrice:value.entryPrice}));
  if(originalLegs.some(value=>![value.quantity,value.entryPrice].every(Number.isFinite)))return;
  // Read times changing alone are not a new financial anomaly. Keep the first actual observation.
  const id=createHash('sha256').update(JSON.stringify([p.id,p.openedAt,exchange,leg.symbol,leg.side,leg.quantity,nativeRows])).digest('hex');
  return {version:1,id,status:'detected',positionId:p.id,base:p.base,openedAt:p.openedAt,detectedAt:now,
    accountReadStartedAt:readStartedAt,lastFinancialActivityAt,observedExchange:exchange,symbol:leg.symbol,side:leg.side,
    expectedQuantity:leg.quantity,nativeQuantity,reason,nativeRows,originalLegs,pausedNewEntry:true};
}

export function accountExposureIncidentMessage(incident:AccountExposureIncident):string {
  const actual=incident.nativeQuantity===null?'多条不明确':String(incident.nativeQuantity);
  return `${incident.base} 账户敞口异常：${incident.observedExchange} ${incident.symbol} ${incident.side} 原数量 ${incident.expectedQuantity}，实际同向数量 ${actual}；已暂停自动新开仓，原现金与数量保留，等待独立原生风险核验；未推定强平或提交补单`;
}
