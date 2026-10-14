import type {AppState,Position} from '../../src/shared/types';
import {ledgerClosedRebate} from './ledger-closed-rebate';
import {positionMoney as money} from './position-formatters';

const tone=(value:number|undefined)=>value===undefined?'':value<0?'negative':value>0?'positive':'';
export default function LedgerClosedNet({position,state,grossNet,showRebates}:{position:Position;
  state:Pick<AppState,'performance'|'unconfirmedOrders'>;grossNet:number|undefined;showRebates:boolean}){
  const estimate=showRebates?ledgerClosedRebate(position,state.performance?.rows,state.unconfirmedOrders):undefined;
  const value=estimate?.estimatedNetPnlAfterRebateUsd??grossNet;
  return <>
    <b className={tone(value)} data-testid="ledger-close-net">{value===undefined?'完整周期收益待核对':money(value,true)}</b>
    <span className="cell-caption ledger-close-caption">{estimate?'返佣后估算 · 完整开平成交':'原账本记录（返佣前）'}</span>
    {estimate&&<>
      <span className="cell-caption">实账净收益（返佣前） <b className={tone(estimate.cashNetPnlUsd)}>{money(estimate.cashNetPnlUsd,true)}</b></span>
      <span className="cell-caption">实账手续费 {money(estimate.grossFeesUsd)} · 预计返佣 {money(estimate.estimatedFeeRebateUsd,true)}</span>
      <span className="cell-caption">预计返佣按配置计算，未确认为到账现金</span>
    </>}
    {!estimate&&showRebates&&<span className="cell-caption">完整周期或返佣证据待核验，不补算缺失现金</span>}
  </>;
}
