import type {AppState,ExchangeId,Position} from '../../src/shared/types';
import {accountPositionKey,accountPositionMatchesLeg} from './account-position-identity';
import {isFreshPortfolioExchange} from './position-observation';
import {positionCloseProgressLabel} from './position-exit-presentation';

export interface CloseSelectionLeg {
  exchange:ExchangeId;symbol:string;side:'long'|'short';quantity:number;
  accountPositionKey:string;positionOpenedAt?:number;
}
export interface PositionCloseAction {enabled:boolean;reason?:string;legs:CloseSelectionLeg[];external:boolean}

function sameCoinPositionIds(position:Position,state:AppState):Set<string> {
  const positions=[position,...state.positions.filter(item=>item.base===position.base)];
  return new Set(positions.flatMap(item=>item.manualCloseSourcePositionId?[item.id,item.manualCloseSourcePositionId]:[item.id]));
}

export function currentCloseOrdersUnknown(position:Position,state:AppState):boolean {
  const ids=sameCoinPositionIds(position,state);
  return !!state.unconfirmedOrders?.some(order=>!order.historical&&ids.has(order.positionId));
}

export function currentCloseOperationInFlight(position:Position,state:AppState):boolean {
  const ids=sameCoinPositionIds(position,state);
  // A preflight without a bound position cannot be safely assigned to another coin.
  return !!state.manualCloseOperations?.some(operation=>['checking','closing'].includes(operation.state)&&
    (!operation.positionId||ids.has(operation.positionId)||operation.id===position.manualCloseOperationId));
}

/** A finished explicit request can leave holdings; it never authorizes an automatic retry. */
export function finishedManualClose(position:Position,state:AppState,operationId=position.manualCloseOperationId):boolean {
  if(!operationId||!position.manualCloseOnly||position.manualCloseOperationId!==operationId||
    !['closing','attention'].includes(position.status)||currentCloseOrdersUnknown(position,state)||currentCloseOperationInFlight(position,state))return false;
  const receipts=state.manualCloseOperations?.filter(operation=>operation.id===operationId)??[];
  if(receipts.length===1)return receipts[0].state==='completed'&&receipts[0].positionId===position.id;
  // Dashboard receipt summaries may be truncated. Only the exact operation's terminal position is fallback evidence.
  return receipts.length===0&&position.status==='attention';
}

/** Manual close permission belongs to the selected current holdings, not the automatic strategy switch. */
export function positionCloseAction(position:Position,state:AppState,now=Date.now()):PositionCloseAction {
  const external=position.id.startsWith('account-display:');
  const blocked=(reason:string):PositionCloseAction=>({enabled:false,reason,legs:[],external});
  if(position.status==='closed'||position.accountClosure)return blocked('该记录已归入历史，请操作当前账户持仓');
  if(currentCloseOrdersUnknown(position,state))return blocked('该币种有未确认订单，等待订单核对后再平仓');
  if(currentCloseOperationInFlight(position,state))return blocked('该币种手动平仓正在检查或处理，等待结果后再平仓');
  if(position.status==='opening')return blocked('本仓位开仓流程尚未结束，等待确认后再平仓');
  if(position.status==='closing'&&!finishedManualClose(position,state))
    return blocked(`${positionCloseProgressLabel(position)}，等待状态核对后再平仓`);
  const sameBase=state.positions.filter(item=>item.base===position.base&&!item.accountClosure&&item.status!=='closed');
  const closing=sameBase.find(item=>item.id!==position.id&&(item.status==='opening'||item.status==='closing'&&!finishedManualClose(item,state)));
  if(closing)return blocked(closing.status==='opening'?'该币种开仓流程尚未结束，等待确认后再平仓':
    `该币种${positionCloseProgressLabel(closing)}，等待状态核对后再平仓`);
  if(position.mode!=='live')return {enabled:true,external,legs:[]};
  const portfolio=state.livePortfolio;
  if(!portfolio)return blocked('账户持仓尚未读取，正在自动刷新');
  const legs:CloseSelectionLeg[]=[];
  const lastActivity=Math.max(position.openedAt,position.closeRequestedAt??0,position.closeAttemptedAt??0);
  for(const leg of [position.long,position.short]){
    // Account projections use a display-only placeholder for an absent side. Never submit it.
    if(external&&leg.quantity===0)continue;
    const account=portfolio.exchanges.find(item=>item.exchange===leg.exchange);
    if(!isFreshPortfolioExchange(account,portfolio,now)||account.requestedAt!<lastActivity)
      return blocked(`${leg.exchange} 账户数据待刷新，确认当前数量后可平仓`);
    const rows=account.positions.filter(row=>accountPositionMatchesLeg(account.exchange,row,leg)&&row.quantity>0);
    if(rows.length>1)return blocked(`${leg.exchange} 存在多个独立分仓，请操作下方对应账户行`);
    for(const row of rows){
      if(!Number.isFinite(row.quantity))return blocked('账户数量无效，等待交易所重新读取');
      if(!external&&row.positionOpenedAt&&Math.abs(row.positionOpenedAt-position.openedAt)>60000)
        return blocked('已是新的开仓周期，请操作对应当前账户行');
      legs.push({exchange:account.exchange,symbol:row.symbol,side:row.side,quantity:row.quantity,
        accountPositionKey:accountPositionKey(account.exchange,row),
        ...(row.positionOpenedAt?{positionOpenedAt:row.positionOpenedAt}:{})});
    }
  }
  return legs.length?{enabled:true,external,legs}:blocked('交易所当前已无该持仓');
}
