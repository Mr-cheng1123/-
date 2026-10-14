import type {JournalOrder,LivePortfolio,Position,PositionLeg} from '../shared/types.js';

export interface FlatAccountEvidence {longAt:number;shortAt:number;latestActivity:number}

/** A single-venue manual account record carries a zero-quantity display leg, not a second contract.
 * Only the exact placeholder created beside its real same-venue leg may be omitted. */
export function accountClosureLegs(position:Position):PositionLeg[] {
  const legs=[position.long,position.short];
  const actual=legs.filter((leg,index)=>{
    const peer=legs[1-index];
    return !(position.manualCloseOnly===true&&position.manualCloseAccountRecord===true&&leg.quantity===0&&
      leg.side===(index===0?'long':'short')&&peer.side===(index===0?'short':'long')&&leg.exchange===peer.exchange&&
      typeof peer.symbol==='string'&&peer.symbol.trim().length>0&&!peer.symbol.includes('#display-absent-')&&
      leg.symbol===`${peer.symbol}#display-absent-${leg.side}`);
  });
  return actual.filter((leg,index)=>actual.findIndex(peer=>peer.exchange===leg.exchange&&peer.symbol===leg.symbol)===index);
}

/** An empty or failed response is not evidence. Every actual account must have independently
 * returned fresh position lists after every known order attempt for this record. */
export function flatAccountEvidence(position:Position,orders:readonly JournalOrder[],portfolio:LivePortfolio,now=Date.now()):FlatAccountEvidence|undefined {
  if(position.mode!=='live'||position.status==='closed'||position.status==='opening'||position.status==='closing'||position.accountClosure)return;
  const times=[position.openedAt,position.closeRequestedAt??0,position.closeAttemptedAt??0,
    ...orders.filter(order=>order.positionId===position.id).flatMap(order=>[order.createdAt,order.result?.timestamp??0])];
  if(!times.every(Number.isFinite))return;
  const latestActivity=Math.max(...times);
  const legs=accountClosureLegs(position);
  const accounts=legs.map(leg=>portfolio.exchanges.find(account=>account.exchange===leg.exchange));
  if(!Number.isFinite(portfolio.maxAgeMs)||portfolio.maxAgeMs<=0)return;
  for(let index=0;index<accounts.length;index++){
    const account=accounts[index],leg=legs[index];
    if(!account||!account.credentialsConfigured||account.status!=='ready'||!Number.isFinite(account.requestedAt)||
      !Number.isFinite(account.receivedAt)||account.requestedAt!<=latestActivity||account.requestedAt!>now||
      account.receivedAt!<account.requestedAt!||now-account.requestedAt!>portfolio.maxAgeMs||!Array.isArray(account.positions))return;
    if(account.positions.some(actual=>!Number.isFinite(actual.quantity)||actual.quantity<0||
      actual.quantity>0&&(actual.base.toUpperCase()===position.base.toUpperCase()||actual.symbol===leg.symbol)))return;
  }
  return {longAt:portfolio.exchanges.find(account=>account.exchange===position.long.exchange)!.requestedAt!,
    shortAt:portfolio.exchanges.find(account=>account.exchange===position.short.exchange)!.requestedAt!,latestActivity};
}
