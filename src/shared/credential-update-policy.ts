import {EXCHANGES,type AccountState,type ExchangeId,type JournalOrder,type Position} from './types.js';
import {isHistoricalJournalOrder,isPositionActive} from './ledger-lifecycle.js';

const knownExchange=(value:unknown):value is ExchangeId=>typeof value==='string'&&(EXCHANGES as readonly string[]).includes(value);
const unresolved=(order:JournalOrder)=>!order.result||!['filled','partial','cancelled'].includes(order.result.status);
const validBase=(value:unknown)=>typeof value==='string'&&value.trim().length>0;

/** A target account is independent of other accounts, unless incomplete records make ownership unknowable. */
export function credentialUpdateBlocker(positions:Position[],orders:JournalOrder[],accounts:ReadonlyMap<ExchangeId,AccountState>,target?:ExchangeId):string|undefined {
  const active=positions.filter(isPositionActive),pending=orders.filter(order=>unresolved(order)&&!isHistoricalJournalOrder(order,positions));
  if(!target){
    if(active.length||pending.length)return '存在持仓或未确认订单，不能更换交易账户';
    for(const account of accounts.values())if(!Array.isArray(account.positions)||account.positions.some(p=>!Number.isFinite(p.quantity)||p.quantity!==0))
      return '已读取的交易所账户仍有持仓或持仓数据不完整，请先核对后再更换凭据';
    return;
  }
  if(!knownExchange(target))return '交易所不支持';
  if(active.some(p=>!knownExchange(p.long?.exchange)||!knownExchange(p.short?.exchange)||!validBase(p.base))||
    pending.some(o=>!knownExchange(o.exchange)||!validBase(o.request?.base)&&!validBase(positions.find(p=>p.id===o.positionId)?.base)))
    return '持仓或未确认订单缺少币种/交易所，无法确认账户归属，请先核对';
  if(active.some(p=>p.long.exchange===target||p.short.exchange===target)||pending.some(o=>o.exchange===target))
    return `${target} 存在持仓或未确认订单，不能更换该交易账户；其他账户仍可配置`;
  const account=accounts.get(target);
  if(account&&(!Array.isArray(account.positions)||account.positions.some(p=>!Number.isFinite(p.quantity)||p.quantity!==0)))
    return `${target} 已读取账户仍有持仓或数据不完整，请先核对后再更换凭据`;
}
