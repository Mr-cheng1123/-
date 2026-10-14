import test from 'node:test';
import assert from 'node:assert/strict';
import {operationAccountConfirmationAt,type OperationAccountObservation} from '../src/core/operation-account-evidence.js';
import type {TradingOperation} from '../src/shared/trading-operations.js';
import type {AccountPosition,ExchangeId,Position} from '../src/shared/types.js';

const position={id:'selected-position',base:'BTC',mode:'live',
  long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long'},
  short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short'}} as Position;
function operation(kind:TradingOperation['kind']='entry'):TradingOperation {
  return {version:1,id:'operation',positionId:position.id,base:position.base,mode:'live',origin:'manual',kind,protocol:'ioc',
    state:'partial',startedAt:1000,updatedAt:2000,target:{long:2,short:2},confirmed:{long:2,short:2},remaining:{long:0,short:0},
    stages:{pairedAt:2000},attempts:{submitted:2,preflightNotSent:0,zeroFill:0,unknown:0}};
}
function account(side:'long'|'short',quantity=2,requestedAt=2100):OperationAccountObservation {
  const row:AccountPosition={base:'BTC',symbol:'BTC/USDT:USDT',side,quantity,markPrice:100,liquidationPrice:0,leverage:2};
  return {requestedAt,account:{freeUsd:1000,equityUsd:1000,positions:quantity?[row]:[]}};
}
function pair(long=account('long'),short=account('short')) {
  return new Map<ExchangeId,OperationAccountObservation>([['gate',long],['bybit',short]]);
}

test('account proof requires both exact contract quantities and a real read beginning strictly after the final pairing',()=>{
  assert.equal(operationAccountConfirmationAt(operation(),position,pair(),2200,5000),2100);
  for(const at of [1900,2000,2300,NaN])
    assert.equal(operationAccountConfirmationAt(operation(),position,pair(account('long',2,at)),2200,5000),undefined);
  assert.equal(operationAccountConfirmationAt(operation(),position,pair(),8000,5000),undefined);
  assert.equal(operationAccountConfirmationAt(operation(),position,new Map([['gate',account('long')]]),2200,5000),undefined);
});

test('different symbols, sides, duplicate slots, incomplete quantities and lot-sized remainders never count as the target',()=>{
  for(const mutate of [
    (row:AccountPosition)=>{row.symbol='BTC/USDC:USDC';},
    (row:AccountPosition)=>{row.side='short';},
    (row:AccountPosition)=>{row.base='OTHER';},
    (row:AccountPosition)=>{row.quantity=1.999;},
    (row:AccountPosition)=>{row.quantity=NaN;},
    (row:AccountPosition)=>{row.splitPositionCount=2;},
  ]){
    const long=account('long');mutate(long.account.positions[0]);
    assert.equal(operationAccountConfirmationAt(operation(),position,pair(long),2200,5000),undefined);
  }
  const duplicate=account('long');duplicate.account.positions.push({...duplicate.account.positions[0]});
  assert.equal(operationAccountConfirmationAt(operation(),position,pair(duplicate),2200,5000),undefined);
});

test('a close requires selected directions flat, including tiny residuals; unrelated contracts do not block its proof',()=>{
  const operationRow=operation('manual-close'),accounts=pair(account('long',0),account('short',0));
  accounts.get('gate')!.account.positions.push({...account('long',3).account.positions[0],base:'ETH',symbol:'ETH/USDT:USDT'});
  assert.equal(operationAccountConfirmationAt(operationRow,position,accounts,2200,5000),2100);
  for(const residual of [2,.001,1e-15])
    assert.equal(operationAccountConfirmationAt(operationRow,position,pair(account('long',residual),account('short',0)),2200,5000),undefined);
});

test('a single selected leg does not require a synthetic absent leg account; empty targets never create completion',()=>{
  const operationRow=operation('manual-close');operationRow.target.short=operationRow.confirmed.short=0;
  assert.equal(operationAccountConfirmationAt(operationRow,position,new Map([['gate',account('long',0)]]),2200,5000),2100);
  operationRow.target.long=operationRow.confirmed.long=0;
  assert.equal(operationAccountConfirmationAt(operationRow,position,new Map(),2200,5000),undefined);
});

test('account balances cannot replace missing receipt, unknown order, working Maker or other position evidence',()=>{
  for(const mutate of [
    (row:TradingOperation)=>{delete row.stages.pairedAt;},
    (row:TradingOperation)=>{row.target.long=null;},
    (row:TradingOperation)=>{row.remaining.long=1;},
    (row:TradingOperation)=>{row.confirmed.short=1;},
    (row:TradingOperation)=>{row.attempts.unknown=1;},
    (row:TradingOperation)=>{row.attempts.pending=1;},
    (row:TradingOperation)=>{row.positionId='other';},
    (row:TradingOperation)=>{row.endedAt=2100;},
  ]){
    const row=operation();mutate(row);
    assert.equal(operationAccountConfirmationAt(row,position,pair(),2200,5000),undefined);
  }
});
