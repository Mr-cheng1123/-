import type { AccountState, ExchangeId, JournalOrder, LiveCoinExclusion, Position } from '../shared/types.js';
import {isPositionActive,isCurrentUnconfirmedOrder} from '../shared/ledger-lifecycle.js';

export function coinBase(value:unknown):string|undefined {
  return typeof value==='string'&&value.trim()?value.trim().toUpperCase():undefined;
}

/** A nonzero position without a coin cannot be safely excluded at coin scope. */
export function accountCoins(account:AccountState):string[]|undefined {
  if(!account||!Number.isFinite(account.freeUsd)||!Array.isArray(account.positions))return undefined;
  const coins=new Set<string>();
  for(const position of account.positions){
    if(!position||!Number.isFinite(position.quantity)||position.quantity<0)return undefined;
    if(position.quantity===0)continue;
    const base=coinBase(position.base);
    if(!base)return undefined;
    coins.add(base);
  }
  return [...coins].sort();
}

export function unresolvedCoin(order:JournalOrder,positions:Position[]):string|undefined {
  return coinBase(order.request?.base)??coinBase(positions.find(p=>p.id===order.positionId)?.base);
}

/** A coin is excluded across all venues; other coins can continue on the same account. */
export function collectCoinExclusions(positions:Position[],orders:JournalOrder[],accounts:ReadonlyMap<ExchangeId,AccountState>,ignorePositionId?:string):LiveCoinExclusion[] {
  const rows=new Map<string,{exchanges:Set<ExchangeId>;reasons:Set<string>}>();
  const add=(base:string|undefined,exchanges:ExchangeId[],reason:string)=>{
    if(!base)return;
    const row=rows.get(base)??{exchanges:new Set<ExchangeId>(),reasons:new Set<string>()};
    for(const exchange of exchanges)row.exchanges.add(exchange);
    row.reasons.add(reason);rows.set(base,row);
  };
  for(const p of positions)if(isPositionActive(p)&&p.id!==ignorePositionId)
    add(coinBase(p.base),[p.long.exchange,p.short.exchange],p.status==='attention'?'该币种执行记录待核对':'该币种已有策略持仓');
  for(const order of orders)if(isCurrentUnconfirmedOrder(order,positions)&&
    (order.positionId!==ignorePositionId||order.result?.status==='unknown'))
    add(unresolvedCoin(order,positions),[order.exchange],'该币种存在未确认订单，禁止重复开仓');
  for(const [exchange,account] of accounts)for(const base of accountCoins(account)??[])
    add(base,[exchange],'交易所已有该币种持仓');
  return [...rows].sort(([a],[b])=>a.localeCompare(b)).map(([base,row])=>({base,exchanges:[...row.exchanges].sort(),reasons:[...row.reasons]}));
}
