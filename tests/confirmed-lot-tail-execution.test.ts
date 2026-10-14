import test from 'node:test';
import assert from 'node:assert/strict';
import {Execution} from '../src/core/execution.js';
import type {Store} from '../src/core/store.js';
import type {ExchangeAdapter,MakerReductionObservation,OrderRequest,OrderResult} from '../src/shared/types.js';
import {lotTailFixture} from './confirmed-lot-tail-fixture.js';

function fixture(options:{partial?:boolean;unknown?:boolean;activeThenRegression?:boolean}={}){
  const f=lotTailFixture(),makerRequests:OrderRequest[]=[],peerRequests:OrderRequest[]=[],cancellations:string[]=[],verifications:Array<{long:number;short:number}>=[],
    native={long:f.p.long.quantity,short:f.p.short.quantity},nativeFilled=new Set<string>();
  let beforeMakerSubmit:(()=>void)|undefined,beforePeerSubmit:(()=>void)|undefined,inspections=0,feeRefreshes=0;
  const store={data:{version:1,config:f.config,positions:[f.p],orders:f.orders,logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const result=(request:OrderRequest,filled:number,id:string):OrderResult=>({id,clientOrderId:request.clientOrderId,
    status:filled===request.quantity?'filled':filled>0?'partial':'cancelled',filledQuantity:filled,averagePrice:filled?request.limitPrice:0,
    averagePriceVerified:true,feeUsd:filled*request.limitPrice*(request.postOnly?.0002:.0005),timestamp:Date.now()});
  const noSend=(request:OrderRequest,code:string):OrderResult=>({...result(request,0,''),rejectionCode:code,rejectionReason:'Memory native guard veto'});
  const originalParent=JSON.stringify(f.parent);
  const ensure=()=>{assert.equal(store.data.positions[0],f.p);assert.equal(JSON.stringify(f.parent),originalParent,'the original Maker receipt and cash must stay exact');};
  const bybit={id:'bybit',supportsMakerReduction:()=>true,validateMakerReduction:async()=>{},
    submitMakerReduction:async(request:OrderRequest,canSubmit?:()=>boolean)=>{
      assert.equal(store.data.orders.at(-1)?.request,request,'the unknown new Maker intent is journalled before native submission');
      assert.equal(store.data.orders.at(-1)?.result?.status,'unknown');
      beforeMakerSubmit?.();if(canSubmit?.()===false)return noSend(request,'MAKER_REDUCTION_PERMISSION_CHANGED');
      makerRequests.push({...request});return {...result(request,0,`NATIVE-AUG-${makerRequests.length}`),status:'unknown' as const};
    },
    inspectMakerReduction:async(request:OrderRequest,id?:string):Promise<MakerReductionObservation>=>{
      assert.ok(id,'the original ACK native ID is reused for every GET');
      if(options.activeThenRegression){
        if(inspections++===0){native.short-=2;return {activity:'active',executionVerified:true,result:{...result(request,2,id!),status:'unknown'},observedAt:Date.now()};}
        return {activity:'terminal',executionVerified:true,result:result(request,0,id!),observedAt:Date.now()};
      }
      if(options.unknown)return {activity:'unknown',executionVerified:false,result:{...result(request,0,id!),status:'unknown'},observedAt:Date.now()};
      const filled=options.partial&&makerRequests.length===1?2:request.quantity;
      if(!nativeFilled.has(id!)){nativeFilled.add(id!);native.short-=filled;}
      return {activity:'terminal',executionVerified:true,result:result(request,filled,id!),observedAt:Date.now()};
    },cancelMakerReduction:async(_request:OrderRequest,id:string)=>{assert.ok(id);cancellations.push(id);},fetchExecutionSnapshots:async()=>[f.short],
  } as unknown as ExchangeAdapter;
  const gate={id:'gate',validateOrder:async()=>{},placeOrder:async(request:OrderRequest,canSubmit?:()=>boolean)=>{
    beforePeerSubmit?.();if(canSubmit?.()===false)return noSend(request,'ORDER_SUBMISSION_PERMISSION_CHANGED');
    assert.equal(f.p.short.quantity,3660,'no peer can use the planned four coins or an incomplete partial confirmation');
    peerRequests.push({...request});native.long-=request.quantity;return result(request,request.quantity,'NATIVE-AGGREGATE-PEER');
  },reconcileOrder:async()=>{throw new Error('Memory unknown original retains original ID');}} as unknown as ExchangeAdapter;
  const execution=new Execution(store,{config:()=>f.config,snapshot:exchange=>exchange==='gate'?f.long:f.short,
    adapter:exchange=>exchange==='gate'?gate:bybit,liveUnlocked:()=>true,makerActionsAllowed:()=>true,
    refreshSnapshots:async()=>{feeRefreshes++;},refreshReductionSnapshots:async()=>{},halt(){}});
  const verify=async()=>{assert.equal(f.p.long.quantity,native.long);assert.equal(f.p.short.quantity,native.short);verifications.push({...native});};
  return {...f,store,execution,makerRequests,peerRequests,cancellations,native,verifications,ensure,verify,
    get feeRefreshes(){return feeRefreshes;},beforeMaker(fn:typeof beforeMakerSubmit){beforeMakerSubmit=fn;},beforePeer(fn:typeof beforePeerSubmit){beforePeerSubmit=fn;}};
}

test('the scoped restoration actually confirms Maker4 then submits a separately linked peer10 once, preserving original cash and principal',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture(),original=structuredClone(f.parent);
  assert.equal(f.execution.canRepairConfirmedMakerLotTail(f.p,f.parent),true);
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),true);
  assert.deepEqual(f.makerRequests.map(request=>[request.quantity,request.side,request.reduceOnly,request.postOnly]),[[4,'buy',true,true]]);
  assert.deepEqual(f.peerRequests.map(request=>[request.quantity,request.side,request.reduceOnly]),[[10,'sell',true]]);
  assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.profitExitNotionalUsd,110.1);
  assert.deepEqual(f.verifications,[{long:3670,short:3660},{long:3660,short:3660}]);assert.deepEqual(f.parent,original);
  assert.equal(f.orders.length,3);assert.equal(f.orders[1].makerReduction?.lotTailOriginalParentClientId,f.parent.request.clientOrderId);
  assert.equal(f.orders[2].executionEvidence?.makerCloseLotTailOriginalParentClientId,f.parent.request.clientOrderId);
  assert.deepEqual(f.orders[2].executionEvidence?.makerCloseLotTailParentClientIds,[f.parent.request.clientOrderId,f.orders[1].request.clientOrderId]);
  assert.ok(Math.abs(f.p.feesUsd-(.2+4*.03*.0002+10*.031*.0005))<1e-12);
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),true,'a repeated completed call observes equality instead of replaying an order');
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,1);
  assert.equal(f.feeRefreshes,1,'only the new finer reduction needs an actual account fee check');
});

test('a fully confirmed original plus augmentation budget repairs its peer without new fee reads or a profit prerequisite',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture();
  const augmentation=f.augmentation(4,4);f.native.short=f.p.short.quantity;
  f.p.short.feesUsd+=augmentation.result!.feeUsd;f.p.feesUsd+=augmentation.result!.feeUsd;
  delete f.long.takerFeeAt;delete f.short.takerFeeAt;delete f.short.makerFeeAt;
  f.p.fundingUsd=-100;
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),true);
  assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,1);assert.equal(f.feeRefreshes,0);
  assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);
});

test('a terminal partial Maker2 must be verified before one remaining Maker2 and its confirmed peer10',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture({partial:true});
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),true);
  assert.deepEqual(f.makerRequests.map(request=>request.quantity),[4,2]);assert.equal(f.peerRequests.length,1);
  assert.deepEqual(f.verifications,[{long:3670,short:3662},{long:3670,short:3660},{long:3660,short:3660}]);
});

test('an unknown original new Maker preserves its ACK ID and cannot mint peer budget or authorize a replay',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture({unknown:true});
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),false);
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);assert.equal(f.p.short.quantity,3664);
  assert.equal(f.orders[1].result?.status,'unknown');assert.equal(f.orders[1].result?.id,'NATIVE-AUG-1');
  assert.equal(f.execution.canRepairConfirmedMakerLotTail(f.p,f.parent),false);assert.equal(f.verifications.length,0);
});

test('profit lost during the native Maker preflight vetoes its actual POST after the durable original intent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture();
  f.beforeMaker(()=>{f.long.bids[0].price=.029;f.long.asks[0].price=.02901;});
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),false);
  assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);assert.equal(f.p.short.quantity,3664);
  assert.equal(f.orders.length,2);assert.equal(f.orders[1].result?.filledQuantity,0);
});

test('a changed frozen step during peer native checks vetoes create and retains the actual confirmed finer reduction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture();f.beforePeer(()=>{f.short.quantityStep=2;});
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),false);
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.long.quantity,3670);
  assert.equal(f.orders[2].result?.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');assert.equal(f.orders[2].result?.filledQuantity,0);
});

test('saving confirmed new Maker cash failure freezes risk and prevents the next peer or compensating create',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture();
  f.store.save=()=>{if(f.orders[1]?.result?.filledQuantity===4)throw new Error('Memory confirmed cash storage failure');};
  await assert.rejects(f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),/storage failure/);
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.p.short.quantity,3660);assert.equal(f.p.long.quantity,3670);assert.equal(f.orders[1].result?.filledQuantity,4);
  assert.equal(f.execution.canRepairConfirmedMakerLotTail(f.p,f.parent),false);
});

test('a submission-evidence save failure vetoes the native Maker create and freezes its durable intent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture();
  f.beforeMaker(()=>{f.store.save=()=>{throw new Error('Memory native permission storage failure');};});
  await assert.rejects(f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),/storage failure/);
  assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.orders.length,2);assert.equal(f.orders[1].request.quantity,4);assert.equal(f.orders[1].result?.filledQuantity,0);
  assert.equal(f.p.short.quantity,3664);assert.equal(f.p.long.quantity,3670);assert.equal(f.verifications.length,0);
});

test('an active confirmed fill lower bound survives contradictory terminal GETs and rejects a later zero replay',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture({activeThenRegression:true});
  assert.equal(await f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),false);
  const journal=f.orders[1],id='NATIVE-AUG-1';assert.equal(f.makerRequests.length,1);assert.deepEqual(f.cancellations,[id]);
  assert.equal(journal.makerReduction?.lotTailObservedExecution?.filledQuantity,2);assert.equal(journal.result?.status,'unknown');
  assert.equal(journal.makerReduction?.bookedExecution,false);assert.equal(f.peerRequests.length,0);assert.equal(f.p.short.quantity,3664);
  assert.equal(f.execution.applyObservedMakerTerminal(journal,{activity:'terminal',executionVerified:true,observedAt:Date.now(),
    result:{id,clientOrderId:journal.request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,averagePriceVerified:true,feeUsd:0,timestamp:Date.now()}}),false);
  assert.equal(journal.makerReduction?.lotTailObservedExecution?.filledQuantity,2);assert.equal(f.execution.canRepairConfirmedMakerLotTail(f.p,f.parent),false);
});

test('failed cancel-marker persistence still cancels the acknowledged original Maker ID and prevents a peer',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture({unknown:true});
  f.store.save=()=>{if(f.orders[1]?.makerReduction?.cancelRequestedAt!==undefined)throw new Error('Memory cancel marker storage failure');};
  await assert.rejects(f.execution.repairConfirmedMakerLotTail(f.p,f.parent,f.ensure,f.verify),/storage failure/);
  assert.deepEqual(f.cancellations,['NATIVE-AUG-1']);assert.equal(f.store.data.killSwitch,true);assert.equal(f.makerRequests.length,1);
  assert.equal(f.peerRequests.length,0);assert.equal(f.p.short.quantity,3664);assert.equal(f.orders[1].result?.id,'NATIVE-AUG-1');
});
