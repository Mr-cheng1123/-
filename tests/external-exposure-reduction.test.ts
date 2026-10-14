import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './external-exposure-reduction-fixture.js';
import type {JournalOrder} from '../src/shared/types.js';

test('native DOS single-leg excess creates one independent IOC and preserves original cash and quantities',async()=>{
  const s=fixture();try{
    const before=structuredClone(s.source),result=await s.run();assert.equal(result.status,'submitted');assert.equal(s.requests.length,1);
    assert.deepEqual(s.source,before);assert.deepEqual(s.accountCalls,['bitget','gate','bitget','gate']);assert.deepEqual(s.orderCalls,['bitget','gate']);
    const request=s.requests[0];assert.equal(request.quantity,100);assert.equal(request.limitPrice,.8);assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);
    const child=s.store.data.positions.find(p=>p.id===result.riskPositionId)!;assert.equal(child.status,'closed');assert.equal(child.long.quantity,0);
    assert.equal(child.feesUsd,.01);assert.equal(child.manualCloseAccountRecord,true);assert.equal(child.externalExposureReduction!.initialExcessQuantity,100);
  }finally{s.cleanup();}
});
test('full fill receives a new double-account GET-only flat proof before risk completion',async()=>{
  const s=fixture();try{
    await s.run();const second=await s.run();assert.equal(second.status,'closed');assert.equal(s.requests.length,1);assert.equal(s.accountCalls.length,8);
    assert.equal(s.orderCalls.length,4);assert.ok(s.store.data.positions[1].accountClosure);assert.equal(s.source.long.quantity,100);assert.equal(s.source.short.quantity,100);
  }finally{s.cleanup();}
});
for(const held of [0,40,100])test(`no prior child and native matched ${held}/${held} completes GET-only risk supervision`,async()=>{
  const s=fixture(held,held);try{const before=structuredClone(s.source),result=await s.run();assert.equal(result.status,'closed');
    assert.equal(result.riskPositionId,undefined);assert.equal(s.requests.length,0);assert.equal(s.store.data.positions.length,1);
    assert.equal(s.accountCalls.length,4);assert.equal(s.orderCalls.length,2);assert.deepEqual(s.source,before);
    assert.equal(s.source.accountClosure,undefined,'a risk-supervisor result cannot fabricate original financial closure');
  }finally{s.cleanup();}
});
test('apparently flat native accounts cannot complete risk supervision past an unknown original order',async()=>{
  const s=fixture(0,0);try{s.store.data.orders.push({positionId:s.source.id,exchange:'bitget',createdAt:Date.now(),request:{
    clientOrderId:'unknown-original',base:'DOS',symbol:s.source.long.symbol,side:'buy',quantity:100,limitPrice:1,reduceOnly:false},
    result:{id:'',clientOrderId:'unknown-original',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}});
    const before=structuredClone(s.store.data.orders);assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);
    assert.deepEqual(s.store.data.orders,before);assert.equal(s.source.accountClosure,undefined);
  }finally{s.cleanup();}
});
test('apparently matched quantities cannot complete risk supervision while a conditional order remains',async()=>{
  const s=fixture(40,40);try{s.setOpenHook(()=>[{id:'pending-conditional',kind:'conditional',quantity:0,remainingQuantity:0}]);
    assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);assert.equal(s.store.data.positions.length,1);
  }finally{s.cleanup();}
});
test('external partial reduction retains matched hedge and closes only the 60-coin excess',async()=>{
  const s=fixture(100,40);try{
    await s.run();assert.equal(s.requests[0].quantity,60);assert.equal(s.accounts.get('bitget')!.positions[0].quantity,40);
    assert.equal((await s.run()).status,'closed');assert.equal(s.requests.length,1);assert.equal(s.store.data.positions[1].accountClosure,undefined);
    assert.equal(s.source.long.quantity,100);assert.equal(s.source.short.quantity,100);
  }finally{s.cleanup();}
});
test('terminal partial fill consumes fixed child budget and requires new stable proofs for each IOC',async()=>{
  const s=fixture(100,40);try{
    s.setResultHook(request=>({id:`partial-${s.requests.length}`,clientOrderId:request.clientOrderId,status:'partial',filledQuantity:20,
      averagePrice:request.limitPrice,feeUsd:.01,timestamp:Date.now()}));await s.run();const child=s.store.data.positions[1];
    assert.equal(child.long.quantity,40);s.setResultHook(undefined);await s.run();assert.deepEqual(s.requests.map(r=>r.quantity),[60,40]);
    assert.equal(s.store.data.positions.length,2);assert.equal(child.externalExposureReduction!.initialExcessQuantity,60);assert.equal(s.accountCalls.length,8);
    assert.equal((await s.run()).status,'closed');
  }finally{s.cleanup();}
});
test('native excess shrinking independently cannot consume more than its current quantity',async()=>{
  const s=fixture(100,40);try{
    s.books.get('bitget')!.bids[0].quantity=20;await s.run();s.accounts.get('bitget')!.positions[0].quantity=60;
    await s.run();assert.deepEqual(s.requests.map(r=>r.quantity),[20,20]);assert.equal(s.store.data.positions[1].long.quantity,20);
    const before=structuredClone(s.store.data.positions[1]);assert.equal((await s.run()).status,'closed');
    assert.deepEqual(s.store.data.positions[1],before,'matching retained hedge must not fabricate consumption of old child budget');
  }finally{s.cleanup();}
});
test('unknown risk receipt prevents every future POST and does not become zero fill',async()=>{
  const s=fixture();try{
    s.setResultHook(request=>({id:'native-unknown',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}));
    await s.run();assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,1);assert.equal(s.store.data.positions[1].long.quantity,100);
  }finally{s.cleanup();}
});
for(const quantity of [NaN,-1,Infinity,undefined])test(`malformed related native quantity ${quantity} cannot prove a flat peer`,async()=>{
  const s=fixture(100,40);try{s.accounts.get('gate')!.positions[0].quantity=quantity as number;assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);
    assert.equal(s.store.data.positions.length,1);}finally{s.cleanup();}
});
for(const field of ['quantity','positionId','positionOpenedAt','side','entryPrice'] as const)test(`two native rounds reject changed ${field}`,async()=>{
  const s=fixture();try{s.setReadHook((exchange,index,account)=>{if(exchange==='bitget'&&index===3){
    const row=account.positions[0];if(field==='quantity')row.quantity=99;else if(field==='positionId')row.positionId='new-native';
    else if(field==='positionOpenedAt')row.positionOpenedAt!+=1;else if(field==='side')row.side='short';else row.entryPrice=1.01;
  }});assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);}finally{s.cleanup();}
});
test('an adapter reusing one account object cannot mutate the first round into a matching proof',async()=>{
  const s=fixture();try{let calls=0;s.options.readAccount=async exchange=>{calls++;if(calls===3)s.accounts.get('bitget')!.positions[0].quantity=90;
    return {account:s.accounts.get(exchange)!,startedAt:Date.now()};};assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);
  }finally{s.cleanup();}
});
test('ordinary or zero-quantity conditional open orders block independent external risk reduction',async()=>{
  const s=fixture();try{s.setOpenHook(exchange=>exchange==='gate'?[{id:'conditional',base:'DOS',symbol:'DOS/USDT:USDT',kind:'conditional',quantity:0,remainingQuantity:0}]:[]);
    assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);}finally{s.cleanup();}
});
test('unscopable unknown journal blocks rather than throwing or bypassing the native guard',async()=>{
  const s=fixture();try{s.store.data.orders.push({positionId:'unidentified',exchange:'gate',createdAt:Date.now()} as JournalOrder);
    assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);}finally{s.cleanup();}
});
test('financial source changes during native GET discard all preflight evidence',async()=>{
  const s=fixture();try{s.setReadHook(()=>{s.source.fundingUsd+=1;});assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);
    assert.equal(s.store.data.positions.length,1);}finally{s.cleanup();}
});
for(const kind of ['same-base','same-contract','manual-child'] as const)test(`a different active ${kind} owner cannot lend its native quantity`,async()=>{
  const s=fixture();try{const sibling=structuredClone(s.source);sibling.id='other-owner';
    if(kind==='same-contract')sibling.base='ALIAS';
    if(kind==='manual-child'){sibling.manualCloseOnly=true;sibling.manualCloseAccountRecord=true;sibling.manualCloseSourcePositionId=s.source.id;}
    s.store.data.positions.push(sibling);assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);
    assert.equal(s.accountCalls.length,0);}finally{s.cleanup();}
});
test('a closed historical same-coin owner does not lend a live budget or block the exact current owner',async()=>{
  const s=fixture();try{const historical=structuredClone(s.source);historical.id='history';historical.status='closed';s.store.data.positions.push(historical);
    await s.run();assert.equal(s.requests.length,1);assert.equal(s.requests[0].quantity,100);}finally{s.cleanup();}
});
test('a new active owner inserted after native reads is rejected by final financial scope',async()=>{
  const s=fixture();try{s.setPostHook(()=>{const sibling=structuredClone(s.source);sibling.id='late-owner';s.store.data.positions.push(sibling);});
    await s.run();assert.equal(s.requests.length,0);}finally{s.cleanup();}
});
test('new native target growth after a confirmed partial risk fill cannot expand its budget',async()=>{
  const s=fixture(100,40);try{s.books.get('bitget')!.bids[0].quantity=20;await s.run();s.accounts.get('bitget')!.positions[0].quantity=90;
    assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,1);}finally{s.cleanup();}
});
test('a peer increasing or reopening after initial authorization cannot lend a new identity to the child',async()=>{
  const s=fixture(100,40);try{s.books.get('bitget')!.bids[0].quantity=20;await s.run();s.accounts.get('gate')!.positions[0].quantity=50;
    assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,1);}finally{s.cleanup();}
});
test('Gate target uses the unique complete native selector and rejects mismatched slot quantities',async()=>{
  const s=fixture(0,100);try{const result=await s.run();assert.equal(result.status,'submitted');assert.equal(s.requests[0].side,'buy');
    assert.equal(s.requests[0].limitPrice,.81);assert.deepEqual(s.requests[0].closePosition,{side:'short',marginMode:'crossed',positionId:'native-short',positionOpenedAt:s.source.openedAt});
  }finally{s.cleanup();}
  const bad=fixture(0,100);try{bad.gateSlots.push({...bad.accounts.get('gate')!.positions[0],quantity:99});
    assert.equal((await bad.run()).status,'waiting');assert.equal(bad.requests.length,0);}finally{bad.cleanup();}
});
test('no actual fee-rate observation does not block explicitly authorized risk reduction',async()=>{
  const s=fixture();try{assert.equal(s.books.get('bitget')!.takerFeeRate,undefined);await s.run();assert.equal(s.requests.length,1);
    assert.equal(s.store.data.positions[1].feesUsd,.01);}finally{s.cleanup();}
});
test('final POST permission handles its own durable journal without admitting another unknown intent',async()=>{
  const s=fixture();try{s.setPostHook(()=>s.store.data.orders.push({positionId:'competing',exchange:'gate',createdAt:Date.now(),request:{
    clientOrderId:'competitor',base:'DOS',symbol:'DOS/USDT:USDT',side:'buy',quantity:1,limitPrice:.81,reduceOnly:true}}));
    await s.run();assert.equal(s.requests.length,0);assert.equal(s.store.data.orders[0].result!.rejectionCode,'IOC_REDUCTION_PERMISSION_CHANGED');
    assert.equal(s.store.data.positions[1].long.quantity,100);}finally{s.cleanup();}
});
test('own request mutation and permission revocation cannot send an order after preflight',async()=>{
  const s=fixture();try{s.setPostHook(request=>{request.quantity=101;});await assert.rejects(()=>s.run(),/原订单或持仓身份已改变/);assert.equal(s.requests.length,0);
    assert.equal(s.store.data.killSwitch,true);assert.equal(s.store.data.unappliedRiskReceipts!.length,1);
    assert.equal(s.store.data.unappliedRiskReceipts![0].request.quantity,100,'retain the original durable request instead of the in-flight mutation');
    assert.equal(s.store.data.positions[1].long.quantity,100);assert.equal(s.store.data.positions[1].feesUsd,0);}finally{s.cleanup();}
  const revoked=fixture();try{revoked.setPostHook(()=>revoked.revoke());await revoked.run();assert.equal(revoked.requests.length,0);}finally{revoked.cleanup();}
});
test('a replaced configuration object cannot authorize POST with the former identical settings',async()=>{
  const s=fixture();try{s.setPostHook(()=>{s.store.data.config={...s.store.data.config};});await s.run();assert.equal(s.requests.length,0);
    assert.equal(s.store.data.positions[1].long.quantity,100);}finally{s.cleanup();}
});
test('unknown native opening cycle or a duplicate native position never becomes an authorized reduction',async()=>{
  const s=fixture();try{s.accounts.get('bitget')!.positions[0].positionOpenedAt=undefined;assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);}finally{s.cleanup();}
  const split=fixture();try{split.accounts.get('bitget')!.positions.push({...split.accounts.get('bitget')!.positions[0],positionId:'split'});
    assert.equal((await split.run()).status,'waiting');assert.equal(split.requests.length,0);}finally{split.cleanup();}
});
test('empty or stale unrefreshable book cannot convert a native excess into a market-priced request',async()=>{
  const s=fixture();try{s.books.get('bitget')!.bids=[];assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,0);}finally{s.cleanup();}
  const stale=fixture();try{stale.books.get('bitget')!.timestamp=Date.now()-60000;stale.options.refreshBooks=async()=>{};
    assert.equal((await stale.run()).status,'waiting');assert.equal(stale.requests.length,0);}finally{stale.cleanup();}
});
test('expired native proof during validation cannot persist or send an IOC',async()=>{
  const s=fixture(),now=Date.now;try{const start=now();s.setValidateHook(()=>{Date.now=()=>start+9000;});
    await assert.rejects(()=>s.run());assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);
  }finally{Date.now=now;s.cleanup();}
});
test('risk-child persistence failure sets kill switch and performs no native POST',async()=>{
  const s=fixture();try{s.store.save=()=>{throw new Error('disk failed');};await assert.rejects(()=>s.run(),/disk failed/);
    assert.equal(s.store.data.killSwitch,true);assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);}finally{s.cleanup();}
});
test('post-fill receipt persistence failure retains original intent and confirmed cash and forbids retry',async()=>{
  const s=fixture();try{const save=s.store.save.bind(s.store);s.store.save=()=>{if(s.store.data.orders[0]?.result)throw new Error('receipt disk failed');save();};
    await assert.rejects(()=>s.run(),/receipt disk failed/);assert.equal(s.requests.length,1);assert.equal(s.store.data.killSwitch,true);
    assert.equal(s.store.data.orders[0].result!.filledQuantity,100);assert.equal(s.store.data.positions[1].long.quantity,0);
    assert.equal((await s.run()).status,'waiting');assert.equal(s.requests.length,1);}finally{s.cleanup();}
});
