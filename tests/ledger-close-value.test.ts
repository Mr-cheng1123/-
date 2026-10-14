import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,AppState,Position} from '../src/shared/types.js';
import type {LedgerHoldingEstimate} from '../web/src/ledger-holding-estimate.js';
import {ledgerPositionMetrics} from '../web/src/ledger-position-metrics.js';
import {ledgerCloseValue,ledgerCloseValueBreakEvenLabel,ledgerCloseValueDeadline,updateLedgerCloseValueCache,
  type LedgerCloseValueCache} from '../web/src/ledger-close-value.js';

const now=1_000_000;
function fixture(){
  const leg=(side:'long'|'short')=>({exchange:side==='long'?'gate' as const:'bybit' as const,symbol:'TESTCLOSE/USDT:USDT',
    side,quantity:100,entryPrice:side==='long'?.99865:1.00135,markPrice:1,feesUsd:.05,liquidationDistancePct:null});
  const position:Position={id:'test-close-record',base:'TESTCLOSE',mode:'live',status:'attention',long:leg('long'),short:leg('short'),
    openedAt:now-200_000,plannedExitAt:0,holdMode:'adaptive',fundingUsd:0,feesUsd:.1,transferCostUsd:0,spreadPnlUsd:.27,
    realizedSpreadPnlUsd:0,netPnlUsd:.17,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const row=(side:'long'|'short'):AccountPosition=>({base:'TESTCLOSE',symbol:'TESTCLOSE/USDT:USDT',side,quantity:100,
    entryPrice:side==='long'?.99865:1.00135,markPrice:1,liquidationPrice:0,leverage:2,unrealizedPnlUsd:.135,realizedPnlUsd:0,fundingUsd:0,feesUsd:.05,
    positionId:`test-${side}`,positionOpenedAt:position.openedAt,cashFlowSince:position.openedAt,
    takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'});
  const state:AppState={timestamp:now,config:{...structuredClone(defaultConfig),mode:'live',dataSource:'public'},running:true,
    autoEnabled:false,killSwitch:false,liveUnlocked:false,opportunities:[],exchanges:[],logs:[],equity:[],risk:{status:'healthy',reasons:[]},
    totals:{fundingUsd:0,feesUsd:0,spreadPnlUsd:0,netPnlUsd:0,grossExposureUsd:0,availableBalanceUsd:0,openPositions:0},
    positions:[position],snapshots:[],livePortfolio:{timestamp:now,pollIntervalMs:2000,maxAgeMs:15_000,exchanges:
      (['gate','bybit'] as const).map((exchange,index)=>({exchange,credentialsConfigured:true,status:'ready',requestedAt:now,
        receivedAt:now,positions:[row(index?'short':'long')]}))}};
  const metrics=ledgerPositionMetrics(position,state.livePortfolio,now);
  const estimate:LedgerHoldingEstimate={nextReviewAt:now+5000,basis:'book',breakEven:'not_recovered',closingFeeSource:'exchange',
    closeNetPnlUsd:-.07,markNetAfterCloseFeeUsd:.07,closingFeesUsd:.1,closeBookObservedAt:now,closeBookExpiresAt:now+2001,
    closeBreakdown:{pricePnlUsd:.13,realizedPnlUsd:0,fundingUsd:0,paidFeesUsd:.1,closingFeesUsd:.1,transferCostUsd:0},
    closePricing:'best-opposite',closeBatch:{kind:'paired',longQuantity:10,shortQuantity:10,longTotalQuantity:100,shortTotalQuantity:100,
      longLimitPrice:.9993,shortLimitPrice:1.0007,longEntryPrice:.99865,shortEntryPrice:1.00135,
      longTopQuantity:10,shortTopQuantity:15,longTakerFeeRate:.0005,shortTakerFeeRate:.0005},
    legs:(['long','short'] as const).map(side=>({side,exchange:position[side].exchange,takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'}))};
  return {position,state,metrics,estimate};
}
function stale(estimate:LedgerHoldingEstimate):LedgerHoldingEstimate {
  return {...estimate,basis:'unknown',closeNetPnlUsd:undefined,closeBreakdown:undefined,closeBookObservedAt:undefined,closeBookExpiresAt:undefined,
    // These deliberately positive mark-based amounts must never replace the book value.
    markNetAfterCloseFeeUsd:.7,closingFeesUsd:.01,breakEven:'unknown'};
}

test('primary close value uses the executable book and never the positive mark fallback',()=>{
  const {position,state,metrics,estimate}=fixture(),before=structuredClone(state);
  const current=ledgerCloseValue(position,metrics,estimate,state,now);
  assert.equal(current.status,'current');assert.equal(current.netPnlUsd,-.07);assert.equal(current.closingFeesUsd,.1);
  assert.equal(current.breakEven,'not_recovered');assert.equal(ledgerCloseValueBreakEvenLabel(current),'尚未回本');
  const missing=ledgerCloseValue(position,metrics,stale(estimate),state,now);
  assert.equal(missing.status,'pending');assert.equal(missing.netPnlUsd,undefined);assert.equal(missing.breakEven,'unknown');
  assert.deepEqual(state,before,'Display valuation must not rewrite accounts, records or automatic permissions.');
});

test('a temporary missing book retains the entire last valuation with neutral recovery status',()=>{
  const {position,state,metrics,estimate}=fixture(),first=ledgerCloseValue(position,metrics,estimate,state,now);
  metrics.netPnlUsd=.85;metrics.unrealizedPnlUsd=.95;metrics.long.markPrice=1.02;
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+2001,first.nextCache);
  assert.equal(retained.status,'retained');assert.equal(retained.netPnlUsd,-.07);assert.equal(retained.closingFeesUsd,.1);
  assert.equal(retained.bookObservedAt,now);assert.equal(retained.nextCache,first.nextCache);
  assert.equal(retained.breakEven,'unknown');assert.equal(ledgerCloseValueBreakEvenLabel(retained),'回本待核验');
});

test('missing native UPL does not discard a complete entry-price book valuation or its cache',()=>{
  const {position,state,metrics,estimate}=fixture();
  metrics.netPnlUsd=undefined;metrics.unrealizedPnlUsd=undefined;metrics.observedSubtotalUsd=undefined;
  metrics.long.unrealizedPnlUsd=undefined;metrics.short.unrealizedPnlUsd=undefined;
  for(const account of state.livePortfolio!.exchanges)account.positions[0].unrealizedPnlUsd=undefined;
  const current=ledgerCloseValue(position,metrics,estimate,state,now);
  assert.equal(current.status,'current');assert.equal(current.netPnlUsd,-.07);
  assert.deepEqual(current.breakdown,estimate.closeBreakdown);
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,current.nextCache);
  assert.equal(retained.status,'retained');assert.equal(retained.netPnlUsd,-.07);
  assert.deepEqual(retained.breakdown,current.breakdown);
});

test('retained breakdown is the detached original entry, book and cash observation',()=>{
  const {position,state,metrics,estimate}=fixture();
  const current=ledgerCloseValue(position,metrics,estimate,state,now),saved=structuredClone(current.breakdown!);
  assert.notEqual(current.breakdown,estimate.closeBreakdown,'The cache owns the complete calculation evidence.');
  estimate.closeBreakdown!.pricePnlUsd=500;estimate.closeBreakdown!.closingFeesUsd=20;
  metrics.unrealizedPnlUsd=-.61;metrics.netPnlUsd=-.71;metrics.long.markPrice=.97;metrics.short.markPrice=1.02;
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,current.nextCache);
  assert.equal(retained.status,'retained');assert.equal(retained.netPnlUsd,-.07);
  assert.deepEqual(retained.breakdown,saved,'New marks, native UPL and mutated estimate must not blend into old book evidence.');
  assert.ok(Math.abs(retained.breakdown!.pricePnlUsd+retained.breakdown!.realizedPnlUsd+retained.breakdown!.fundingUsd-
    retained.breakdown!.paidFeesUsd-retained.breakdown!.closingFeesUsd-retained.breakdown!.transferCostUsd-retained.netPnlUsd!)<1e-12);
});

for(const entryPrice of [undefined,0,NaN])test(`missing or invalid actual entry (${entryPrice}) prevents current valuation and cache reuse`,()=>{
  const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
  metrics.long.entryPrice=entryPrice;state.livePortfolio!.exchanges[0].positions[0].entryPrice=entryPrice;
  const current=ledgerCloseValue(position,metrics,estimate,state,now+1000,cache);
  assert.equal(current.status,'pending');assert.equal(current.netPnlUsd,undefined);assert.equal(current.nextCache,undefined);
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,cache);
  assert.equal(retained.status,'pending');assert.equal(retained.netPnlUsd,undefined);assert.equal(retained.nextCache,undefined);
});

test('changed transfer cost invalidates the old net and establishes a complete replacement only with new evidence',()=>{
  const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
  position.transferCostUsd=.025;
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,cache);
  assert.equal(retained.status,'pending');assert.equal(retained.netPnlUsd,undefined);assert.equal(retained.nextCache,undefined);
  estimate.closeNetPnlUsd=-.095;estimate.closeBreakdown!.transferCostUsd=.025;
  estimate.closeBookObservedAt=now+3000;estimate.closeBookExpiresAt=now+5001;
  const replacement=ledgerCloseValue(position,metrics,estimate,state,now+3000,cache);
  assert.equal(replacement.status,'current');assert.equal(replacement.netPnlUsd,-.095);
  assert.equal(replacement.breakdown!.transferCostUsd,.025);
});

for(const invalid of ['missing','nonfinite-price','nonfinite-cash','closing-fee','net-total'] as const)
  test(`an incomplete or inconsistent ${invalid} calculation never becomes a current net value`,()=>{
    const {position,state,metrics,estimate}=fixture();
    if(invalid==='missing')estimate.closeBreakdown=undefined;
    if(invalid==='nonfinite-price')estimate.closeBreakdown!.pricePnlUsd=NaN;
    if(invalid==='nonfinite-cash')estimate.closeBreakdown!.fundingUsd=Infinity;
    if(invalid==='closing-fee')estimate.closeBreakdown!.closingFeesUsd=.15;
    if(invalid==='net-total')estimate.closeNetPnlUsd=.5;
    const value=ledgerCloseValue(position,metrics,estimate,state,now);
    assert.equal(value.status,'pending');assert.equal(value.netPnlUsd,undefined);assert.equal(value.nextCache,undefined);
  });

test('a previous cache with a corrupted breakdown cannot outlive validation',()=>{
  const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache!;
  const corrupted={...cache,breakdown:{...cache.breakdown,pricePnlUsd:50}};
  const value=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,corrupted);
  assert.equal(value.status,'pending');assert.equal(value.netPnlUsd,undefined);assert.equal(value.nextCache,undefined);
});

test('retention expires exactly ten seconds after the earliest book observation without extending on retries',()=>{
  const {position,state,metrics,estimate}=fixture();
  estimate.closeBookObservedAt=now-750;estimate.closeBookExpiresAt=now+1251;
  const first=ledgerCloseValue(position,metrics,estimate,state,now),cache=first.nextCache!;
  assert.equal(cache.retainUntil,now+9250);
  const last=ledgerCloseValue(position,metrics,stale(estimate),state,now+9249,cache);
  assert.equal(last.status,'retained');assert.equal(last.nextCache,cache);
  const expired=ledgerCloseValue(position,metrics,stale(estimate),state,now+9250,cache);
  assert.equal(expired.status,'pending');assert.equal(expired.netPnlUsd,undefined);assert.equal(expired.nextCache,undefined);
  assert.equal(expired.breakEven,'unknown');assert.equal(ledgerCloseValueBreakEvenLabel(expired),'回本待核验');
});

test('a formerly recovered value never claims current recovery after its book expires',()=>{
  const {position,state,metrics,estimate}=fixture();estimate.closeNetPnlUsd=.12;estimate.closeBreakdown!.pricePnlUsd=.32;
  estimate.closeBatch!.longLimitPrice=1.00025;estimate.closeBatch!.shortLimitPrice=.99975;
  const current=ledgerCloseValue(position,metrics,estimate,state,now);
  assert.equal(ledgerCloseValueBreakEvenLabel(current),'预计已回本（分批估算）');
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,current.nextCache);
  assert.equal(retained.netPnlUsd,.12);assert.equal(retained.breakEven,'unknown');
  assert.equal(ledgerCloseValueBreakEvenLabel(retained),'回本待核验');
});

test('a fresh complete replacement supersedes the retained value and its fee amount',()=>{
  const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
  const latest={...estimate,closeNetPnlUsd:.23,closingFeesUsd:.101,closeBookObservedAt:now+4000,closeBookExpiresAt:now+6001,
    closeBreakdown:{...estimate.closeBreakdown!,pricePnlUsd:.431,closingFeesUsd:.101},
    closeBatch:{...estimate.closeBatch!,longLimitPrice:1.010805,shortLimitPrice:1.009195}};
  const value=ledgerCloseValue(position,metrics,latest,state,now+4000,cache);
  assert.equal(value.status,'current');assert.equal(value.netPnlUsd,.23);assert.equal(value.closingFeesUsd,.101);
  assert.equal(value.breakEven,'recovered');assert.equal(value.nextCache!.retainUntil,now+14_000);
});

test('actual quantity changes clear an old estimate even if both legs remain paired',()=>{
  const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
  metrics.long.quantity=106;metrics.short.quantity=106;
  for(const account of state.livePortfolio!.exchanges)account.positions[0].quantity=106;
  const changed=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,cache);
  assert.equal(changed.status,'pending');assert.equal(changed.netPnlUsd,undefined);assert.equal(changed.nextCache,undefined);
});

for(const field of ['realizedPnlUsd','fundingUsd','feesUsd'] as const)test(`a changed per-leg ${field} invalidates an estimate even when the total stays equal`,()=>{
  const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
  metrics.long[field]!+=.01;metrics.short[field]!-=.01;
  const changed=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,cache);
  assert.equal(changed.status,'pending');assert.equal(changed.netPnlUsd,undefined);assert.equal(changed.nextCache,undefined);
});

for(const change of ['record','opened','symbol','side','account-key','native-id','native-cycle','native-cash-cycle','entry-price'] as const)
  test(`a changed ${change} cannot reuse another holding cycle's value`,()=>{
    const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
    if(change==='record')position.id='another-record';
    if(change==='opened')position.openedAt+=1000;
    if(change==='symbol')position.long.symbol='OTHER/USDT:USDT';
    if(change==='side')position.long.side='short';
    if(change==='account-key')position.long.accountPositionKey='another-native-row';
    if(change==='native-id')state.livePortfolio!.exchanges[0].positions[0].positionId='new-native-cycle';
    if(change==='native-cycle')state.livePortfolio!.exchanges[0].positions[0].positionOpenedAt!+=1000;
    if(change==='native-cash-cycle')state.livePortfolio!.exchanges[0].positions[0].cashFlowSince!+=1000;
    if(change==='entry-price')state.livePortfolio!.exchanges[0].positions[0].entryPrice=1.01;
    const changed=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,cache);
    assert.equal(changed.status,'pending');assert.equal(changed.netPnlUsd,undefined);assert.equal(changed.nextCache,undefined);
  });

test('changed, unknown and expired official fee rates invalidate retained values',()=>{
  for(const change of ['rate','unknown','expired'] as const){
    const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
    const missing=stale(estimate);
    if(change==='rate')missing.legs[0]={...missing.legs[0],takerFeeRate:.0006};
    if(change==='unknown')missing.closingFeeSource='unknown';
    if(change==='expired')missing.legs[0]={...missing.legs[0],takerFeeAt:now-118_000};
    const changed=ledgerCloseValue(position,metrics,missing,state,now+3000,cache);
    assert.equal(changed.status,'pending');assert.equal(changed.netPnlUsd,undefined);assert.equal(changed.nextCache,undefined);
  }
});

test('fee timestamps may refresh at the same official rate without invalidating the same cash cycle',()=>{
  const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
  const missing=stale(estimate);missing.legs=missing.legs.map(leg=>({...leg,takerFeeAt:now+3000}));
  assert.equal(ledgerCloseValue(position,metrics,missing,state,now+3000,cache).status,'retained');
});

test('local reference fees retain complete display values without pretending they are native account reads',()=>{
  const {position,state,metrics,estimate}=fixture(),before=structuredClone(state);
  estimate.closingFeeSource='reference';estimate.legs=estimate.legs.map(leg=>({...leg,takerFeeAt:undefined,
    takerFeeSource:'reference',takerFeeReferenceSource:'official-reference',feeProfile:'unknown'}));
  const current=ledgerCloseValue(position,metrics,estimate,state,now);
  assert.equal(current.status,'current');assert.equal(current.closingFeeSource,'reference');
  assert.equal(current.netPnlUsd,-.07);assert.equal(ledgerCloseValueBreakEvenLabel(current),'参考尚未回本（本地费率）');
  assert.ok(current.feeLegs?.every(leg=>leg.takerFeeSource==='reference'&&leg.takerFeeAt===undefined));
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,current.nextCache);
  assert.equal(retained.status,'retained');assert.equal(retained.closingFeeSource,'reference');
  assert.equal(retained.netPnlUsd,-.07);assert.deepEqual(retained.breakdown,current.breakdown);
  assert.equal(ledgerCloseValueBreakEvenLabel(retained),'回本待核验');
  assert.deepEqual(state,before,'Local fee estimates cannot change execution permission, account cash or holdings.');
});

for(const change of ['rate','leg-source','reference-source','profile','reference-at'] as const)
  test(`changed ${change} invalidates the whole reference close-value cache`,()=>{
    const {position,state,metrics,estimate}=fixture();
    estimate.closingFeeSource='reference';estimate.legs=estimate.legs.map(leg=>({...leg,takerFeeAt:undefined,
      takerFeeSource:'reference',takerFeeReferenceSource:'account-reference',takerFeeReferenceAt:now-200_000,feeProfile:'unknown'}));
    const current=ledgerCloseValue(position,metrics,estimate,state,now),cache=current.nextCache;
    assert.equal(current.status,'current');const missing=structuredClone(stale(estimate));
    if(change==='rate')missing.legs[0].takerFeeRate=.0006;
    if(change==='leg-source'){missing.legs[0].takerFeeSource='exchange';missing.legs[0].takerFeeAt=now;}
    if(change==='reference-source')missing.legs[0].takerFeeReferenceSource='official-reference';
    if(change==='profile')missing.legs[0].feeProfile='standard';
    if(change==='reference-at')missing.legs[0].takerFeeReferenceAt=now-100_000;
    const changed=ledgerCloseValue(position,metrics,missing,state,now+3000,cache);
    assert.equal(changed.status,'pending');assert.equal(changed.netPnlUsd,undefined);assert.equal(changed.nextCache,undefined);
  });

test('fee source cannot be invented from a rate and timestamp or hidden by an exchange aggregate label',()=>{
  for(const change of ['no-source','reference-as-exchange','unknown-reference','future-reference'] as const){
    const {position,state,metrics,estimate}=fixture();
    if(change==='no-source')estimate.legs[0].takerFeeSource=undefined;
    else{
      estimate.legs[0].takerFeeSource='reference';estimate.legs[0].takerFeeReferenceSource='account-reference';
      estimate.legs[0].takerFeeReferenceAt=now-1000;
      if(change==='unknown-reference'){estimate.closingFeeSource='reference';estimate.legs[0].takerFeeReferenceSource=undefined;}
      if(change==='future-reference'){estimate.closingFeeSource='reference';estimate.legs[0].takerFeeReferenceAt=now+1;}
    }
    const value=ledgerCloseValue(position,metrics,estimate,state,now);
    assert.equal(value.status,'pending');assert.equal(value.pendingReason,'fees');assert.equal(value.nextCache,undefined);
  }
});

test('unverified accounts, flat holdings, missing cash and historical records discard the cache immediately',()=>{
  for(const change of ['unverified','flat','cash','closed','archive','cycle-mismatch'] as const){
    const {position,state,metrics,estimate}=fixture(),cache=ledgerCloseValue(position,metrics,estimate,state,now).nextCache;
    if(change==='unverified')metrics.observation.status='unverified';
    if(change==='flat'){metrics.observation.status='account_flat';metrics.holding='flat';}
    if(change==='cash'){metrics.long.fundingUsd=undefined;metrics.fundingUsd=undefined;metrics.netPnlUsd=undefined;}
    if(change==='closed')position.status='closed';
    if(change==='archive')position.accountClosure={confirmedAt:now+2500,reason:'empty',historicalOrdersPending:false};
    if(change==='cycle-mismatch')metrics.cycleMismatch=true;
    const invalid=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,cache);
    assert.equal(invalid.status,'pending');assert.equal(invalid.netPnlUsd,undefined);assert.equal(invalid.nextCache,undefined);
  }
});

test('StrictMode repeated effects keep unchanged cache references; invalid and removed holdings are pruned',()=>{
  const {position,state,metrics,estimate}=fixture();
  const first=ledgerCloseValue(position,metrics,estimate,state,now),empty=new Map<string,LedgerCloseValueCache>();
  const map=updateLedgerCloseValueCache(empty,new Map([[position.id,first]]));
  const repeated=ledgerCloseValue(position,metrics,estimate,state,now,map.get(position.id));
  assert.equal(repeated.nextCache,first.nextCache);
  assert.equal(updateLedgerCloseValueCache(map,new Map([[position.id,repeated]])),map);
  assert.equal(ledgerCloseValueDeadline(map),now+10_000);
  const expired=ledgerCloseValue(position,metrics,stale(estimate),state,now+10_000,map.get(position.id));
  const pruned=updateLedgerCloseValueCache(map,new Map([[position.id,expired]]));
  assert.equal(pruned.size,0);assert.equal(ledgerCloseValueDeadline(pruned),undefined);
  assert.equal(updateLedgerCloseValueCache(pruned,new Map()),pruned);
});

test('a still fresh REST valuation remains current after ten seconds but cannot extend the retention window',()=>{
  const {position,state,metrics,estimate}=fixture();estimate.closeBookObservedAt=now-15_000;estimate.closeBookExpiresAt=now+15_001;
  const current=ledgerCloseValue(position,metrics,estimate,state,now);
  assert.equal(current.status,'current');assert.equal(current.nextCache,undefined);
  assert.equal(ledgerCloseValue(position,metrics,stale(estimate),state,now+100).status,'pending');
});

test('external paired holdings with different native opening times still show their current complete account value',()=>{
  const {position,state,estimate}=fixture();position.id='account-display:external-pair';
  state.livePortfolio!.exchanges[1].positions[0].positionOpenedAt=position.openedAt+90_000;
  const metrics=ledgerPositionMetrics(position,state.livePortfolio,now);
  assert.equal(metrics.cycleMismatch,true);
  const current=ledgerCloseValue(position,metrics,estimate,state,now);
  assert.equal(current.status,'current');assert.equal(current.netPnlUsd,-.07);
  state.livePortfolio!.exchanges[1].positions[0].positionOpenedAt!+=5000;
  const changed=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,current.nextCache);
  assert.equal(changed.status,'pending');assert.equal(changed.nextCache,undefined);
});

test('retained estimates preserve the original batch prices, quantities and official fees together',()=>{
  const {position,state,metrics,estimate}=fixture();
  const first=ledgerCloseValue(position,metrics,estimate,state,now),saved={...first.closeBatch!};
  assert.notEqual(first.closeBatch,estimate.closeBatch,'A cache owns a detached copy of its batch evidence.');
  estimate.closeBatch!.longQuantity=50;estimate.closeBatch!.shortQuantity=50;
  estimate.closeBatch!.longTopQuantity=50;estimate.closeBatch!.shortTopQuantity=75;
  estimate.closeBatch!.longLimitPrice=.8;estimate.closeBatch!.shortLimitPrice=1.2;
  const retained=ledgerCloseValue(position,metrics,stale(estimate),state,now+3000,first.nextCache);
  assert.equal(retained.status,'retained');assert.equal(retained.netPnlUsd,-.07);assert.equal(retained.closingFeesUsd,.1);
  assert.equal(retained.closePricing,'best-opposite');assert.deepEqual(retained.closeBatch,saved);
});

test('a freshly changed first batch replaces its evidence even when net amount, fees and sample timestamp are identical',()=>{
  const {position,state,metrics,estimate}=fixture();
  const first=ledgerCloseValue(position,metrics,estimate,state,now);
  estimate.closeBatch={...estimate.closeBatch!,longQuantity:5,shortQuantity:5,longTopQuantity:5,shortTopQuantity:8};
  const replacement=ledgerCloseValue(position,metrics,estimate,state,now,first.nextCache);
  assert.equal(replacement.status,'current');assert.equal(replacement.netPnlUsd,first.netPnlUsd);
  assert.notEqual(replacement.nextCache,first.nextCache);assert.equal(replacement.closeBatch!.longQuantity,5);
  assert.equal(first.closeBatch!.longQuantity,10);
});

test('a conditional amount without a legal first batch never becomes a current estimated close value',()=>{
  for(const change of ['missing','zero','too-large','missing-total','missing-fee','missing-entry','wrong-entry'] as const){
    const {position,state,metrics,estimate}=fixture();
    if(change==='missing')estimate.closeBatch=undefined;
    if(change==='zero'){estimate.closeBatch!.longQuantity=0;estimate.closeBatch!.shortQuantity=0;}
    if(change==='too-large')estimate.closeBatch!.longQuantity=50;
    if(change==='missing-total')estimate.closeBatch!.shortTotalQuantity=0;
    if(change==='missing-fee')estimate.closeBatch!.longTakerFeeRate=undefined;
    if(change==='missing-entry')estimate.closeBatch!.longEntryPrice=undefined;
    if(change==='wrong-entry')estimate.closeBatch!.longEntryPrice=1.1;
    const value=ledgerCloseValue(position,metrics,estimate,state,now);
    assert.equal(value.status,'pending');assert.equal(value.netPnlUsd,undefined);assert.equal(value.breakEven,'unknown');
  }
});
