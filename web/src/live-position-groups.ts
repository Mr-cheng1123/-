import type {AccountPosition,ExchangeId,Position} from '../../src/shared/types';
import {instrumentIdentityBlockReason} from '../../src/shared/instrument-identity';
import {accountPositionMatchesLeg} from './account-position-identity';

export interface LivePositionRow extends AccountPosition {
  exchange:ExchangeId;
  receivedAt?:number;
  rowKey:string;
}

export interface LivePositionGroup {
  id:string;
  base:string;
  paired:boolean;
  source:'ledger'|'account';
  rows:LivePositionRow[];
}

const baseOf=(row:{base:string})=>row.base.toUpperCase();
const alphabetical=(a:string,b:string)=>a.localeCompare(b,'en');
const rowOrder=(a:LivePositionRow,b:LivePositionRow)=>alphabetical(baseOf(a),baseOf(b))||
  alphabetical(a.exchange,b.exchange)||alphabetical(a.symbol,b.symbol)||alphabetical(a.side,b.side)||alphabetical(a.rowKey,b.rowKey);
const quantityDistance=(a:number,b:number)=>Math.abs(Math.log(a/b));
const compatible=(long:LivePositionRow,short:LivePositionRow)=>long.side==='long'&&short.side==='short'&&
  long.exchange!==short.exchange&&baseOf(long)===baseOf(short)&&!instrumentIdentityBlockReason(long.base,long.exchange,short.exchange);

/** Arrange fresh account observations only. A display pair does not assert equal quantities or change any exposure. */
export function groupLivePositions(input:LivePositionRow[],positions:Position[]):LivePositionGroup[] {
  const rows=input.filter(row=>Number.isFinite(row.quantity)&&row.quantity>0).slice().sort(rowOrder);
  const remaining=new Set(rows),groups:LivePositionGroup[]=[];
  const addPair=(long:LivePositionRow,short:LivePositionRow,source:LivePositionGroup['source'])=>{
    remaining.delete(long);remaining.delete(short);
    groups.push({id:JSON.stringify([long.rowKey,short.rowKey]),base:baseOf(long),paired:true,source,rows:[long,short]});
  };
  // Preserve actual strategy relationships when both exact contract legs are still present.
  // Never revive a closed record, match a symbol alias, or pair different assets sharing a ticker.
  const active=positions.filter(position=>position.mode==='live'&&position.status!=='closed'&&!position.accountClosure&&
    position.long.quantity>0&&position.short.quantity>0).slice().sort((a,b)=>
      alphabetical(a.base.toUpperCase(),b.base.toUpperCase())||a.openedAt-b.openedAt||alphabetical(a.id,b.id));
  for(const position of active){
    const match=(leg:Position['long'])=>[...remaining].filter(row=>accountPositionMatchesLeg(row.exchange,row,leg)&&
      baseOf(row)===position.base.toUpperCase()).sort((a,b)=>
        quantityDistance(a.quantity,leg.quantity)-quantityDistance(b.quantity,leg.quantity)||rowOrder(a,b))[0];
    const long=match(position.long),short=match(position.short);
    if(long&&short&&compatible(long,short))addPair(long,short,'ledger');
  }
  // Manual or independently observed holdings have no strategy mapping. Match opposite
  // cross-venue legs deterministically, preferring the closest base-coin quantities.
  const candidates=[...remaining].filter(row=>row.side==='long').flatMap(long=>
    [...remaining].filter(short=>compatible(long,short)).map(short=>({long,short,distance:quantityDistance(long.quantity,short.quantity)})))
    .sort((a,b)=>alphabetical(baseOf(a.long),baseOf(b.long))||a.distance-b.distance||rowOrder(a.long,b.long)||rowOrder(a.short,b.short));
  for(const {long,short} of candidates)if(remaining.has(long)&&remaining.has(short))addPair(long,short,'account');
  groups.sort((a,b)=>alphabetical(a.base,b.base)||alphabetical(a.id,b.id));
  for(const row of [...remaining].sort(rowOrder))groups.push({id:row.rowKey,base:baseOf(row),paired:false,source:'account',rows:[row]});
  return groups;
}
