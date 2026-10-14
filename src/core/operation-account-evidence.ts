import type {AccountState,ExchangeId,Position} from '../shared/types.js';
import type {TradingOperation} from '../shared/trading-operations.js';

export interface OperationAccountObservation {account:AccountState;requestedAt:number}

/** Diagnostic evidence only. A cached read begun before the final fill cannot confirm its account effect. */
export function operationAccountConfirmationAt(operation:TradingOperation,position:Position,
  accounts:ReadonlyMap<ExchangeId,OperationAccountObservation>,now:number,maxAgeMs:number):number|undefined {
  const pairedAt=operation.stages.pairedAt;
  if(operation.positionId!==position.id||operation.base!==position.base||operation.mode!==position.mode||
    operation.endedAt!==undefined||!Number.isFinite(pairedAt)||!Number.isFinite(now)||
    !Number.isFinite(maxAgeMs)||maxAgeMs<=0||operation.attempts.unknown>0||
    (operation.attempts.pending??0)>0)return;
  const observed:number[]=[];
  for(const side of ['long','short'] as const){
    const target=operation.target[side],confirmed=operation.confirmed[side],leg=position[side];
    if(target===null||confirmed===null||!Number.isFinite(target)||target<0||
      operation.remaining[side]!==0||!sameQuantity(target,confirmed))return;
    // A one-leg manual selection has no authority or account requirement for its absent display leg.
    if(target===0)continue;
    const observation=accounts.get(leg.exchange),at=observation?.requestedAt;
    if(!observation||!Number.isFinite(at)||at!<=pairedAt!||at!>now||now-at!>maxAgeMs||
      !Array.isArray(observation.account.positions))return;
    const contract=observation.account.positions.filter(row=>row?.symbol===leg.symbol);
    if(contract.some(row=>!['long','short'].includes(row.side)||!Number.isFinite(row.quantity)||row.quantity<0))return;
    const matching=contract.filter(row=>row.side===side&&row.quantity>0);
    const expected=operation.kind==='entry'?target:0;
    if(expected===0){if(matching.length)return;}
    else if(matching.length!==1||matching[0].base!==position.base||
      (matching[0].splitPositionCount??1)>1||!sameQuantity(matching[0].quantity,expected))return;
    observed.push(at!);
  }
  return observed.length?Math.max(...observed):undefined;
}

function sameQuantity(left:number,right:number):boolean {
  return Number.isFinite(left)&&Number.isFinite(right)&&Math.abs(left-right)<=Math.max(Math.abs(left),Math.abs(right))*Number.EPSILON*8;
}
