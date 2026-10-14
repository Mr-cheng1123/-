import type {ExchangeId,Position} from '../../src/shared/types';
import type {LedgerPositionMetrics,ObservedLedgerLeg} from './ledger-position-metrics';
import type {LedgerCloseValue} from './ledger-close-value';

const names:Record<ExchangeId,string>={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};
const fields={realizedPnlUsd:'已实现价格损益',fundingUsd:'到账资金费',feesUsd:'已付手续费'};
type CashField=keyof typeof fields;
const finite=(value:number|undefined)=>Number.isFinite(value);
const stateLabel=(leg:ObservedLedgerLeg)=>leg.quantity===undefined?'账户持仓未核实':leg.quantity===0?'已平腿的历史现金待核对':
  leg.cashFlowStatus==='error'?'账单读取失败':leg.cashFlowStatus==='unavailable'?'账单周期待确认':
    leg.cashFlowStatus==='incomplete'?'账单归属待核对':leg.cashFlowStatus==='stale'?'账单已过期':
      leg.cashFlowStatus==='loading'?'账单读取中':'当前周期现金未完整返回';

/** Explain missing current-cycle evidence without changing any amount or closing guard. */
export function ledgerCashPresentation(position:Position,metrics:LedgerPositionMetrics){
  const legs=(['long','short'] as const).map(side=>({side,leg:metrics[side],
    label:`${side==='long'?'多':'空'} ${names[position[side].exchange]}`}));
  const missing=(field:CashField)=>legs.filter(({leg})=>!finite(leg[field]));
  const reasons=(field:CashField)=>finite(metrics[field])?[]:missing(field)
    .map(({leg,label})=>`${label}：${stateLabel(leg)}，${fields[field]}待核对`);
  const fieldLabel=(field:CashField)=>{
    const missingLegs=missing(field),name=field==='fundingUsd'?'资金费':field==='feesUsd'?'已付费用':'已实现损益';
    if(missingLegs.some(({leg})=>leg.quantity===0))return `历史${name}待核对`;
    if(missingLegs.some(({leg})=>leg.cashFlowStatus==='error'))return `${name}读取失败`;
    if(missingLegs.some(({leg})=>leg.cashFlowStatus==='loading'))return `${name}读取中`;
    return `${name}待核对`;
  };
  const details=legs.flatMap(({leg,label})=>{
    const unknown=(Object.keys(fields) as CashField[]).filter(field=>!finite(leg[field]));
    return unknown.length?[`${label}：${stateLabel(leg)}；缺少${unknown.map(field=>fields[field]).join('、')}`]:[];
  });
  const transferMissing=!finite(position.transferCostUsd)||position.transferCostUsd<0;
  if(transferMissing)details.push('转账成本尚未核实，不按零计算');
  const observations=legs.filter(({leg})=>finite(leg.cashFlowAt)&&leg.cashFlowAt!>0&&leg.cashFlowStatus&&leg.cashFlowStatus!=='ready'&&
    (Object.keys(fields) as CashField[]).every(field=>finite(leg[field])))
    .map(({leg,label})=>leg.cashFlowStatus==='incomplete'?`${label}：最近已核现金，本次账单归属待核对`:
      `${label}：保留原采样已核现金；本次${stateLabel(leg)}`);
  const cashPendingLabel=details.length===1&&transferMissing?'转账成本待核对':
    legs.some(({leg})=>leg.quantity===0&&(Object.keys(fields) as CashField[]).some(field=>!finite(leg[field])))?'已平腿现金待核对':
      legs.some(({leg})=>leg.cashFlowStatus==='error'&&(Object.keys(fields) as CashField[]).some(field=>!finite(leg[field])))?'账单读取失败':
        legs.some(({leg})=>leg.cashFlowStatus==='unavailable'&&(Object.keys(fields) as CashField[]).some(field=>!finite(leg[field])))?'账单周期待核对':'现金账单待核对';
  const closePendingLabel=(reason:LedgerCloseValue['pendingReason'])=>reason==='cash'?cashPendingLabel:
    reason==='account'?metrics.cycleMismatch?'持仓周期待核对':'待读取':reason==='entry'?'开仓均价待读取':
      reason==='fees'?'平仓费率待核对':'盘口同步中';
  return {fundingLabel:fieldLabel('fundingUsd'),realizedLabel:fieldLabel('realizedPnlUsd'),feesLabel:fieldLabel('feesUsd'),
    fundingReasons:reasons('fundingUsd'),details,observations,closePendingLabel};
}
