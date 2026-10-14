import test from 'node:test';
import assert from 'node:assert/strict';
import {credentialUpdateBlocker} from '../src/shared/credential-update-policy.js';
import {isCurrentUnconfirmedOrder,isHistoricalJournalOrder,isPositionActive,isUnconfirmedJournalOrder} from '../src/shared/ledger-lifecycle.js';
import type {AccountState,ExchangeId,JournalOrder,OrderResult,Position} from '../src/shared/types.js';

const archivedPosition=():Position=>({id:'old-position',base:'BTC',status:'attention',
  long:{exchange:'gate',quantity:1},short:{exchange:'bybit',quantity:2},
  accountClosure:{confirmedAt:2000,reason:'Both accounts independently confirmed flat',historicalOrdersPending:true}} as Position);
const order=(createdAt=1000,result?:OrderResult):JournalOrder=>({positionId:'old-position',exchange:'gate',createdAt,result,
  request:{base:'BTC',clientOrderId:'old-request',symbol:'BTC/USDT:USDT',side:'buy',quantity:1,limitPrice:100,reduceOnly:false}});
const accounts=()=>new Map<ExchangeId,AccountState>([['gate',{freeUsd:100,equityUsd:100,positions:[]}]]);

test('flat-account proof retires current exposure without rewriting the original position or order',()=>{
  const position=archivedPosition(),journal=order(),before=JSON.stringify({position,journal});
  assert.equal(isPositionActive(position),false);assert.equal(isHistoricalJournalOrder(journal,[position]),true);
  assert.equal(isCurrentUnconfirmedOrder(journal,[position]),false);
  assert.equal(JSON.stringify({position,journal}),before);assert.equal(position.status,'attention');assert.equal(position.long.quantity,1);
});

test('newer or unrelated unknown orders remain current after historical closure',()=>{
  const position=archivedPosition();
  assert.equal(isCurrentUnconfirmedOrder(order(2001),[position]),true);
  assert.equal(isCurrentUnconfirmedOrder({...order(),positionId:'new-position'},[position]),true);
  assert.equal(isCurrentUnconfirmedOrder(order(),[]),true);
  assert.equal(isHistoricalJournalOrder(order(NaN),[position]),false);
  assert.equal(isHistoricalJournalOrder(order(),[{...position,accountClosure:{...position.accountClosure!,confirmedAt:NaN}}]),false);
});

test('unarchived local exposure and order outcomes retain their existing blocker semantics',()=>{
  const position=archivedPosition();delete position.accountClosure;
  assert.equal(isPositionActive(position),true);assert.equal(isPositionActive({...position,status:'closed'}),false);
  assert.equal(isCurrentUnconfirmedOrder(order(),[position]),true);
  assert.equal(isCurrentUnconfirmedOrder(order(1000,{status:'unknown'} as OrderResult),[position]),true);
  for(const status of ['filled','partial','cancelled'] as const)
    assert.equal(isCurrentUnconfirmedOrder(order(1000,{id:'native-old',clientOrderId:'old-request',status,
      filledQuantity:status==='filled'?1:status==='partial'?.5:0,averagePrice:status==='cancelled'?0:100,feeUsd:0,timestamp:1000}),[position]),false);
});

test('malformed historical terminal labels remain current blockers until complete original-order cash is verified',()=>{
  const position=archivedPosition();delete position.accountClosure;
  const receipt:OrderResult={id:'native-old',clientOrderId:'old-request',status:'filled',filledQuantity:1,averagePrice:100,
    averagePriceVerified:true,feeUsd:.05,timestamp:1000};
  const changes:Array<Partial<OrderResult>>=[{clientOrderId:'foreign'},{id:''},{filledQuantity:.5},{filledQuantity:0},
    {filledQuantity:1.01},{filledQuantity:NaN},{averagePrice:NaN},{averagePrice:101},{averagePriceVerified:false},
    {feeUsd:NaN},{feeUsd:null as unknown as number},{status:'new' as OrderResult['status']}];
  for(const change of changes){
    const journal=order(1000,{...receipt,...change}),before=structuredClone(journal);
    assert.equal(isUnconfirmedJournalOrder(journal),true);assert.equal(isCurrentUnconfirmedOrder(journal,[position]),true);
    assert.deepEqual(journal,before);
    position.accountClosure={confirmedAt:2000,reason:'账户独立确认为空',historicalOrdersPending:true};
    assert.equal(isUnconfirmedJournalOrder(journal),true);assert.equal(isCurrentUnconfirmedOrder(journal,[position]),false);
    delete position.accountClosure;
  }
});

test('verified rebates, no-fill native charges and proven local no-submit receipts retain complete cash semantics',()=>{
  const receipt:OrderResult={id:'native-old',clientOrderId:'old-request',status:'filled',filledQuantity:1,averagePrice:100,
    feeUsd:-.01,timestamp:1000};
  assert.equal(isUnconfirmedJournalOrder(order(1000,receipt)),false);
  assert.equal(isUnconfirmedJournalOrder(order(1000,{...receipt,status:'cancelled',filledQuantity:0,averagePrice:NaN,feeUsd:.02})),false);
  assert.equal(isUnconfirmedJournalOrder(order(1000,{...receipt,id:'',status:'cancelled',filledQuantity:0,averagePrice:0,
    feeUsd:0,rejectionCode:'PRE_SUBMISSION_CHECK_FAILED'})),false);
  assert.equal(isUnconfirmedJournalOrder(order(1000,{...receipt,id:'',status:'cancelled',filledQuantity:0,averagePrice:0,
    feeUsd:0,rejectionCode:'10016'})),true);
});

test('archived local records no longer prevent scoped or global credential updates',()=>{
  const position=archivedPosition();
  for(const result of [undefined,{status:'unknown'} as OrderResult,{status:'new'} as unknown as OrderResult]){
    assert.equal(credentialUpdateBlocker([position],[order(1000,result)],accounts()),undefined);
    assert.equal(credentialUpdateBlocker([position],[order(1000,result)],accounts(),'gate'),undefined);
    assert.equal(credentialUpdateBlocker([position],[order(1000,result)],accounts(),'bybit'),undefined);
  }
});

test('fresh positions and orders protect credentials even when the old record was archived',()=>{
  const position=archivedPosition();
  assert.match(credentialUpdateBlocker([position],[order(2001)],accounts(),'gate')!,/未确认订单/);
  const held=accounts();held.get('gate')!.positions=[{base:'BTC',symbol:'BTC/USDT:USDT',side:'long',quantity:1,markPrice:100,leverage:2,liquidationPrice:0}];
  assert.match(credentialUpdateBlocker([position],[order()],held,'gate')!,/账户仍有持仓/);
  assert.match(credentialUpdateBlocker([position],[order()],held)!,/账户仍有持仓/);
  assert.match(credentialUpdateBlocker([{...position,accountClosure:undefined}],[],accounts(),'gate')!,/存在持仓/);
});
