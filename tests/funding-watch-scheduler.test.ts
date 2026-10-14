import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleFundingWatches,type FundingWatchSelection} from '../src/core/funding-watch-scheduler.js';
import type {FundingCandidate} from '../src/shared/funding-opportunities.js';

const START=1_700_000_000_000,DURATION=210_000;
function candidate(base:string,afterFeesUsd:number,eligible=true):FundingCandidate {
  return {id:`${base}-gate-bitget`,base,longExchange:'gate',shortExchange:'bitget',
    longRate:0,shortRate:(afterFeesUsd+.22)/100,longIntervalHours:8,shortIntervalHours:8,
    normalized8hBps:10,aprPct:10,notionalUsd:100,nextFundingTime:START+3_600_000,exitTime:START+3_610_000,
    longFundingCount:1,shortFundingCount:1,grossFundingUsd:afterFeesUsd+.22,feesUsd:.22,afterFeesUsd,
    slippageBudgetUsd:0,transferCostUsd:0,fundingHaircutUsd:0,basisReserveUsd:0,expectedNetUsd:afterFeesUsd,
    candidateEligible:eligible,reasons:[],updatedAt:START};
}
const run=(candidates:FundingCandidate[],watched=new Map<string,FundingWatchSelection>(),checked=new Map<string,number>(),
  now=START,extra:Partial<Parameters<typeof scheduleFundingWatches>[0]>={})=>scheduleFundingWatches({
    candidates,watched,checked,excludedBases:new Set(),now,durationMs:DURATION,limit:6,discoverySlots:2,
    canFit:()=>true,...extra,
  });
const bases=(result:ReturnType<typeof run>)=>[...result.watched.keys()];
const income=()=>['A','B','C','D','E','F','G','H'].map((base,rank)=>candidate(base,8-rank));

test('fee-net priority beats gross-only and ordinary-ready routes without promoting a blocked entry',()=>{
  const low={...candidate('NET',.05,false),normalized8hBps:5};
  const ioc={...candidate('IOC',-.1),grossFundingUsd:.1};
  const manualReady={...candidate('READY',-.1),grossFundingUsd:50};
  const grossOnly=income().map(c=>({...c,grossFundingUsd:100,feesUsd:101,afterFeesUsd:-1}));
  const priorities=new Map([[low.id,3],[ioc.id,4],[manualReady.id,2]]);
  const result=run([manualReady,...grossOnly,low,ioc],new Map(),new Map(),START,{
    ranking:'gross-funding',readyBases:new Set(['READY','IOC']),verificationPriorities:priorities,
  });
  assert.deepEqual([...result.watched.values()].filter(w=>w.kind==='core').map(w=>w.candidate.base),['IOC','NET','READY','A']);
  assert.equal(result.watched.size,6);
  assert.equal(result.watched.get('NET')!.candidate.candidateEligible,false,'observation cannot grant entry eligibility');
});

test('more positive references than capacity rotate through the two discovery places',()=>{
  const candidates=['A','B','C','D','E','F','G','H','I','J'].map((base,i)=>candidate(base,10-i,false));
  const priorities=new Map(candidates.map(c=>[c.id,3]));
  const first=run(candidates,new Map(),new Map(),START,{verificationPriorities:priorities});
  const second=run(candidates,first.watched,first.checked,START+DURATION+1,{verificationPriorities:priorities});
  const third=run(candidates,second.watched,second.checked,START+2*DURATION+2,{verificationPriorities:priorities});
  assert.deepEqual(bases(first),['A','B','C','D','E','F']);
  assert.deepEqual(bases(second),['A','B','C','D','G','H']);
  assert.deepEqual(bases(third),['A','B','C','D','I','J']);
  for(const result of [first,second,third])assert.equal(result.watched.size,6);
});

test('a new positive priority displaces unfinished ordinary discovery but preserves manual and occupied scopes',()=>{
  const candidates=income(),first=run(candidates);
  const manual=candidate('MANUAL',-.1),held=candidate('HELD',100),arrival=candidate('ARRIVAL',.01,false);
  const watched=new Map(first.watched).set(manual.base,{candidate:manual,manual:true,selectedAt:START,expiresAt:START+DURATION});
  const result=run([...candidates,held,manual,arrival],watched,first.checked,START+5000,{
    verificationPriorities:new Map([[held.id,4],[arrival.id,3]]),excludedBases:new Set(['HELD']),
  });
  assert.equal(result.watched.size,6);
  assert.equal(result.watched.get('MANUAL')?.manual,true);
  assert.equal(result.watched.get('MANUAL')?.expiresAt,START+DURATION);
  assert.equal(result.watched.has('HELD'),false);
  assert.equal(result.watched.get('ARRIVAL')?.kind,'core');
});

test('a currently actionable lower-rate coin stays under foreground refresh before unchecked higher-rate coins',()=>{
  const result=run(income(),new Map(),new Map(),START,{readyBases:new Set(['G'])});
  assert.deepEqual([...result.watched.values()].filter(w=>w.kind==='core').map(w=>w.candidate.base),['G','A','B','C']);
  assert.equal(result.watched.size,6);
});

test('core income ranking comes before fairness; discovery rotates among lower-profit positive coins',()=>{
  const candidates=income(),checked=new Map<string,number>([['base:A',START],['base:B',START],['base:C',START],['base:D',START],['base:E',START]]);
  const result=run(candidates,new Map(),checked);
  assert.deepEqual(bases(result),['A','B','C','D','F','G']);
  assert.deepEqual([...result.watched.values()].filter(w=>w.kind==='core').map(w=>w.candidate.base),['A','B','C','D']);
  assert.equal(checked.has('base:F'),false,'the scheduler must not mutate its input history');
});

test('better income immediately replaces fee-negative automatic watches despite an unfinished window',()=>{
  const poor=['U','V','W','X','Y','Z'].map(base=>candidate(base,-.1));
  const old=run(poor);
  const result=run([...income(),...poor],old.watched,old.checked,START+5000);
  assert.deepEqual(bases(result),['A','B','C','D','E','F']);
  assert.ok([...result.watched.values()].every(w=>w.candidate.afterFeesUsd>0));
});

test('core baselines continue through expiry while discovery gives untouched positive coins their turn',()=>{
  const candidates=income(),first=run(candidates),next=run(candidates,first.watched,first.checked,START+DURATION+1);
  assert.deepEqual(bases(first),['A','B','C','D','E','F']);
  assert.deepEqual(bases(next),['A','B','C','D','G','H']);
  assert.ok([...next.watched.values()].every(w=>w.expiresAt>START+DURATION+1));
  const third=run(candidates,next.watched,next.checked,START+2*DURATION+2);
  assert.deepEqual(bases(third),['A','B','C','D','E','F']);
});

test('manual fee-negative lookup receives its full window and releases its priority after expiry',()=>{
  const low=candidate('MANUAL',-.1),candidates=[...income(),low];
  const manual:FundingWatchSelection={candidate:low,selectedAt:START,expiresAt:START+1000,manual:true};
  const first=run(candidates,new Map([[low.base,manual]]),new Map(),START+500);
  assert.deepEqual(bases(first),['MANUAL','A','B','C','D','E']);
  assert.equal(first.watched.get('MANUAL')?.expiresAt,START+DURATION);
  assert.equal(first.watched.get('MANUAL')?.manual,true);
  const next=run(candidates,first.watched,first.checked,START+DURATION+1);
  assert.equal(next.watched.has('MANUAL'),false);
  assert.ok([...next.watched.values()].every(w=>!w.manual));
});

test('a new core leader preserves discovery coins until they have completed their sampling window',()=>{
  const candidates=income(),first=run(candidates);
  const updated=[candidate('NEW',100),...candidates];
  const next=run(updated,first.watched,first.checked,START+5000);
  assert.deepEqual(bases(next),['NEW','A','B','C','E','F']);
  assert.equal(next.watched.get('E')?.selectedAt,START);
  assert.equal(next.watched.get('F')?.expiresAt,START+DURATION);
});

test('profit tiers prevent zero-history fee-negative coins from displacing positive discovery routes',()=>{
  const candidates=[...income(),candidate('FEE_NEGATIVE',-.1)];
  const checked=new Map(income().map(c=>[`base:${c.base}`,START] as const));
  assert.deepEqual(bases(run(candidates,new Map(),checked)),['A','B','C','D','E','F']);
});

test('fee-negative routes remain discoverable when positive routes leave spare capacity',()=>{
  const result=run([candidate('A',1),candidate('B',.5),candidate('C',-.01),candidate('D',-.02)]);
  assert.deepEqual(bases(result),['A','B','C','D']);
  assert.equal(result.watched.get('C')?.kind,'discovery');
  assert.equal(result.watched.get('D')?.kind,'discovery');
});

test('a blocked high-number candidate cannot displace viable coins from the income core',()=>{
  const result=run([candidate('BLOCKED',100,false),...income()]);
  assert.deepEqual(bases(result),['A','B','C','D','E','F']);
});

test('one coin with multiple venue routes consumes one slot and chooses its highest viable income',()=>{
  const worse=candidate('A',-.1),better={...candidate('A',10),id:'A-bybit-gate',longExchange:'bybit' as const,shortExchange:'gate' as const};
  const result=run([worse,...income(),better]);
  assert.equal(result.watched.size,6);
  assert.equal(result.watched.get('A')?.candidate.id,better.id);
});

test('portfolio capacity and occupied coins cannot be displaced by candidate ranking',()=>{
  const candidates=income();
  const result=run(candidates,new Map(),new Map(),START,{excludedBases:new Set(['A']),canFit:(candidate,selected)=>candidate.base!=='B'&&selected.size<3});
  assert.deepEqual(bases(result),['C','D','E']);
  assert.equal(result.watched.has('A'),false);
  assert.equal(result.watched.has('B'),false);
});

test('brief missing statistics preserves unexpired watches without treating them as current candidates',()=>{
  const first=run(income()),next=run([],first.watched,first.checked,START+5000);
  assert.deepEqual(bases(next),bases(first));
  assert.equal(next.watched.get('A')?.expiresAt,first.watched.get('A')?.expiresAt);
  assert.equal(run([],next.watched,next.checked,START+DURATION+1).watched.size,0);
});

test('a manual route can disappear while its other valid route keeps the coin baseline intact',()=>{
  const old=candidate('A',1),replacement={...candidate('A',2),id:'A-bybit-gate',longExchange:'bybit' as const,shortExchange:'gate' as const};
  const watched=new Map([[old.base,{candidate:old,manual:true,selectedAt:START,expiresAt:START+DURATION}]]);
  const next=run([replacement,...income().slice(1)],watched,new Map(),START+5000);
  assert.equal(next.watched.get('A')?.candidate.id,replacement.id);
  assert.equal(next.watched.get('A')?.manual,true);
  assert.equal(next.watched.get('A')?.selectedAt,START);
});

test('aligned income core uses positive gross funding even when one receipt does not pay four fees',()=>{
  const candidates=income().map((c,i)=>({...c,grossFundingUsd:.2-i*.02,feesUsd:.4,afterFeesUsd:-.2-i*.02,expectedNetUsd:-.2-i*.02}));
  const result=run(candidates,new Map(),new Map(),START,{ranking:'gross-funding'});
  assert.deepEqual(bases(result),['A','B','C','D','E','F']);
  assert.ok([...result.watched.values()].slice(0,4).every(w=>w.kind==='core'));
  assert.ok([...result.watched.values()].every(w=>w.candidate.afterFeesUsd<0));
});

test('execution-ready routes retain core priority while uncredentialed routes remain public discovery candidates',()=>{
  const authorized=income(),publicOnly={...candidate('PUBLIC',100),longExchange:'binance' as const,id:'PUBLIC-binance-bitget'};
  const bestPublicSameCoin={...candidate('A',200),longExchange:'binance' as const,id:'A-binance-bitget'};
  const result=run([publicOnly,bestPublicSameCoin,...authorized],new Map(),new Map(),START,{preferCore:c=>c.longExchange!=='binance'});
  assert.deepEqual([...result.watched.values()].filter(w=>w.kind==='core').map(w=>w.candidate.base),['A','B','C','D']);
  assert.equal(result.watched.get('A')?.candidate.longExchange,'gate','a better public-only route must not erase the same coin authorized core route');
  assert.ok(result.watched.has('PUBLIC'),'public-only venues are visible in discovery, without authorizing trading');
});
