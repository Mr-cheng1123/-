import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {TradingOperationTracker,type BeginTradingOperation} from '../src/core/trading-operation-tracker.js';
import type {JournalOrder,Position} from '../src/shared/types.js';

const root='D:/codex/tmp/execution-operation-improvements-20261012/tracker-tests';mkdirSync(root,{recursive:true});
function setup(t:{after:(fn:()=>void)=>void},options:{endedLimit?:number;hardLimit?:number}={}){
  const directory=mkdtempSync(join(root,'case-')),path=join(directory,'state.json');let now=1000;
  writeFileSync(path,'{"realFinancialState":"preserve exactly"}');
  const tracker=new TradingOperationTracker(path,{now:()=>now,debounceMs:60_000,...options});t.after(()=>tracker.dispose());
  return {tracker,path,tick:(value:number)=>{now=value;},clock:()=>now};
}
function begin(overrides:Partial<BeginTradingOperation>={}):BeginTradingOperation {
  return {positionId:'position',base:'BTC',mode:'live',origin:'automatic',kind:'profit-exit',protocol:'maker-ioc',
    target:{long:2,short:2},...overrides};
}
function position():Position {
  return {id:'position',base:'BTC',mode:'live',status:'open',openedAt:100,plannedExitAt:999_000,holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:2,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:2,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
}
function order(side:'long'|'short',id:string,qty=2,at=1100,reduceOnly=true):JournalOrder {
  const p=position();return {positionId:p.id,exchange:p[side].exchange,createdAt:at,
    request:{clientOrderId:id,base:p.base,symbol:p[side].symbol,side:side==='long'?(reduceOnly?'sell':'buy'):(reduceOnly?'buy':'sell'),
      quantity:qty,limitPrice:100,reduceOnly},
    result:{id:'native-'+id,clientOrderId:id,status:'filled',filledQuantity:qty,averagePrice:100,feeUsd:.1,timestamp:at+10},
    execution:{bookObservedAt:at,quoteAgeMs:0,bookTransport:'rest',confirmedAt:at+10}};
}
function paired(tracker:TradingOperationTracker,tick:(at:number)=>void){
  const p=position(),orders=[order('long','long'),order('short','short')];tick(1100);orders.forEach(o=>tracker.orderSubmitted(p,o));
  tick(1200);tracker.observe(p,orders);return {p,orders};
}

test('automatic retry retains the operation identity while each manual submission is a distinct operation',t=>{
  const {tracker,tick}=setup(t);const first=tracker.begin(begin())!;tick(1050);
  assert.equal(tracker.begin(begin({kind:'funding-exit'}))!.id,first.id);
  const manual=tracker.begin(begin({origin:'manual',kind:'manual-close'}))!;tick(1100);
  const again=tracker.begin(begin({origin:'manual',kind:'manual-close'}))!;
  assert.notEqual(manual.id,again.id);assert.equal(tracker.snapshot().counts.total,3);
  assert.equal(tracker.current('position')!.id,again.id);
});

test('local operation lookups return isolated records without including ended rows in the active set',t=>{
  const {tracker,tick}=setup(t),first=tracker.begin(begin())!;
  const lookup=tracker.get(first.id)!,active=tracker.activeRows();
  lookup.target.long=999;active[0].remaining.long=999;active[0].state='failed';
  assert.equal(tracker.get(first.id)!.target.long,2);assert.equal(tracker.get(first.id)!.remaining.long,2);
  assert.equal(tracker.activeRows()[0].state,'running');assert.equal(tracker.get('missing'),undefined);
  tick(1100);tracker.end(first.id,'partial');
  assert.deepEqual(tracker.activeRows(),[]);assert.equal(tracker.get(first.id)!.state,'partial');
});

test('restarted unfinished observations remain accessible history but never reenter the process-owned active set',t=>{
  const {tracker,path,tick}=setup(t),first=tracker.begin(begin())!;tick(1100);tracker.flush();
  const restarted=new TradingOperationTracker(path,{now:()=>1200,debounceMs:60_000});t.after(()=>restarted.dispose());
  assert.equal(restarted.get(first.id)!.state,'unknown');assert.deepEqual(restarted.activeRows(),[]);
  const second=restarted.begin(begin({id:'new-after-restart'}))!;
  assert.deepEqual(restarted.activeRows().map(row=>row.id),[second.id]);
  assert.equal(restarted.snapshot().counts.total,2);assert.equal(restarted.confirm(first.id,1200),false);
});

test('only locally confirmed native terminal IOC receipts supply acknowledgement timing, including zero fills',t=>{
  const {tracker,tick}=setup(t),p=position();tracker.begin(begin());
  const receipt=order('long','zero');receipt.result!.status='cancelled';receipt.result!.filledQuantity=0;
  receipt.result!.averagePrice=0;receipt.result!.feeUsd=0;
  tick(1100);tracker.orderSubmitted(p,receipt);tick(1200);tracker.observe(p,[receipt]);
  const row=tracker.current(p.id)!;
  assert.equal(row.stages.acknowledgedAt,1110);assert.equal(row.stages.firstFillObservedAt,undefined);
  assert.equal(row.attempts.zeroFill,1);assert.equal(row.attempts.unknown,0);
  receipt.execution!.confirmedAt=1190;tracker.observe(p,[receipt]);
  assert.equal(tracker.current(p.id)!.stages.acknowledgedAt,1110,'retain the first local receipt confirmation');
});

test('paper client-ID stand-ins, unknown results and pre-submit or future confirmation timestamps have no native ACK evidence',t=>{
  for(const variant of ['paper','unknown','before-submit','future'] as const){
    const {tracker,tick}=setup(t),p=position();tracker.begin(begin());const receipt=order('long',variant);
    if(variant==='paper')receipt.result!.id=receipt.request.clientOrderId;
    if(variant==='unknown')receipt.result!.status='unknown';
    if(variant==='before-submit')receipt.execution!.confirmedAt=1099;
    if(variant==='future')receipt.execution!.confirmedAt=1201;
    tick(1100);tracker.orderSubmitted(p,receipt);tick(1200);tracker.observe(p,[receipt]);
    assert.equal(tracker.current(p.id)!.stages.acknowledgedAt,undefined,variant);
  }
});

test('bound native target fills still await independent account confirmation and never write the financial store',t=>{
  const {tracker,path,tick}=setup(t),before=readFileSync(path,'utf8');const op=tracker.begin(begin())!;
  const {orders}=paired(tracker,tick),sourceBefore=structuredClone(orders);
  assert.equal(tracker.current('position')!.state,'partial');assert.equal(tracker.snapshot().counts.complete,0);
  assert.equal(tracker.confirm(op.id,1199),false);tick(1300);assert.equal(tracker.confirm(op.id,1300),true);
  tracker.flush();assert.equal(tracker.snapshot().counts.complete,1);assert.equal(tracker.current('position'),undefined);
  assert.equal(readFileSync(path,'utf8'),before);assert.deepEqual(orders,sourceBefore);assert.ok(existsSync(path+'.operations.json'));
});

test('unbound historical fills and repeated observations cannot finish a current operation or double count quantities',t=>{
  const {tracker,tick}=setup(t),p=position();tracker.begin(begin());
  const historical=[order('long','historical-long',2,500),order('short','historical-short',2,500)];
  tick(1100);historical.forEach(o=>tracker.orderSubmitted(p,o));tracker.observe(p,historical);
  assert.deepEqual(tracker.current(p.id)!.confirmed,{long:0,short:0});
  const current=order('long','current');tracker.orderSubmitted(p,current);tick(1200);
  tracker.observe(p,[...historical,current]);tracker.observe(p,[...historical,current]);
  assert.deepEqual(tracker.current(p.id)!.confirmed,{long:2,short:0});assert.equal(tracker.current(p.id)!.attempts.submitted,1);
});

test('identity mismatch, duplicate native ownership and mutated original request remain unknown',t=>{
  const {tracker,tick}=setup(t),p=position();const op=tracker.begin(begin())!;
  const long=order('long','long');tick(1100);tracker.orderSubmitted(p,long);tick(1200);
  long.result!.clientOrderId='wrong';tracker.observe(p,[long]);assert.equal(tracker.current(p.id)!.attempts.unknown,1);
  long.result!.clientOrderId='long';const duplicate=order('long','different');duplicate.result!.id=long.result!.id;
  tracker.observe(p,[long,duplicate]);assert.equal(tracker.current(p.id)!.attempts.unknown,1);
  long.request.quantity=3;tracker.observe(p,[long]);assert.equal(tracker.confirm(op.id,1200),false);
  assert.equal(tracker.current(p.id)!.state,'unknown');
});

test('one-sided, partial and unknown execution cannot be completed with an account timestamp alone',t=>{
  const {tracker,tick}=setup(t),p=position();const op=tracker.begin(begin())!;
  const long=order('long','long',1),short=order('short','short');short.result!.status='unknown';short.result!.filledQuantity=0;
  tick(1100);[long,short].forEach(o=>tracker.orderSubmitted(p,o));tick(1200);tracker.observe(p,[long,short]);
  assert.deepEqual(tracker.current(p.id)!.remaining,{long:1,short:null});assert.equal(tracker.confirm(op.id,1200),false);
  assert.equal(tracker.snapshot().counts.unknown,1);
});

test('unknown lower bounds, request conflicts and missing journals cannot turn an uncertain leg total into zero or its terminal prefix',t=>{
  for(const scenario of ['unknown-lower-bound','request-conflict','missing-journal'] as const){
    const {tracker,tick}=setup(t),p=position(),op=tracker.begin(begin())!;
    const prefix=order('long','prefix',1),uncertain=order('long','uncertain',1),short=order('short','short');
    tick(1100);[prefix,uncertain,short].forEach(journal=>tracker.orderSubmitted(p,journal));
    if(scenario==='unknown-lower-bound'){uncertain.result!.status='unknown';uncertain.result!.filledQuantity=.5;}
    if(scenario==='request-conflict')uncertain.request.quantity=3;
    tick(1200);tracker.observe(p,scenario==='missing-journal'?[prefix,short]:[prefix,uncertain,short]);
    const row=tracker.current(p.id)!;
    assert.deepEqual(row.confirmed,{long:null,short:2},scenario);assert.deepEqual(row.remaining,{long:null,short:0},scenario);
    assert.equal(row.attempts.unknown,1);assert.equal(row.attempts.zeroFill,0);assert.equal(row.state,'unknown');
    assert.equal(tracker.confirm(op.id,1200),false);
  }
});

test('a positively identified working Maker is pending rather than an unknown failure',t=>{
  const {tracker,tick}=setup(t),p=position(),op=tracker.begin(begin())!,maker=order('long','maker');
  maker.request.postOnly=true;maker.result!.status='unknown';maker.result!.filledQuantity=0;maker.result!.feeUsd=0;maker.result!.averagePrice=0;
  maker.makerReduction={activity:'active',makerLeg:'long',deadlineAt:6000,acknowledgedAt:1120};
  tick(1100);tracker.orderSubmitted(p,maker);tick(1200);tracker.observe(p,[maker]);
  const row=tracker.current(p.id)!;assert.equal(row.state,'running');assert.equal(row.attempts.pending,1);
  assert.equal(row.attempts.unknown,0);assert.equal(row.stages.acknowledgedAt,1120);assert.equal(tracker.confirm(op.id,1200),false);
});

test('a still-running adapter call is pending, while interrupted or invalid missing receipts remain unknown',t=>{
  for(const scenario of ['running','attention','error','missing-journal','mutated-request'] as const){
    const {tracker,tick}=setup(t),p=position(),op=tracker.begin(begin())!,journal=order('long',scenario);
    delete journal.result;tick(1100);tracker.orderSubmitted(p,journal);
    if(scenario==='attention')p.status='attention';
    if(scenario==='error')journal.error='adapter failed';
    if(scenario==='mutated-request')journal.request.quantity=3;
    tick(1200);tracker.observe(p,scenario==='missing-journal'?[]:[journal]);
    const row=tracker.current(p.id)!;
    assert.equal(row.attempts.pending,scenario==='running'?1:0,scenario);
    assert.equal(row.attempts.unknown,scenario==='running'?0:1,scenario);
    assert.equal(row.attempts.zeroFill,0);assert.equal(tracker.confirm(op.id,1200),false);
    assert.deepEqual(row.confirmed,{long:scenario==='running'?0:null,short:0});
  }
});

test('initial native Maker ACK awaiting first inspection is pending, but inspected or stopped uncertainty stays unknown',t=>{
  for(const scenario of ['awaiting-inspect','inspected-unknown','stopped','error','attention','client-id-stand-in'] as const){
    const {tracker,tick}=setup(t),p=position(),op=tracker.begin(begin())!,journal=order('long',scenario);
    journal.request.postOnly=true;journal.result!.status='unknown';journal.result!.filledQuantity=0;
    journal.result!.averagePrice=0;journal.result!.feeUsd=0;
    journal.makerReduction={activity:'unknown',makerLeg:'long',deadlineAt:6000,acknowledgedAt:1120};
    if(scenario==='inspected-unknown')journal.makerReduction.lastObservedAt=1150;
    if(scenario==='stopped')journal.makerReduction.stopReason='inspect required';
    if(scenario==='error')journal.error='native receipt requires reconciliation';
    if(scenario==='attention')p.status='attention';
    if(scenario==='client-id-stand-in')journal.result!.id=journal.request.clientOrderId;
    tick(1100);tracker.orderSubmitted(p,journal);tick(1200);tracker.observe(p,[journal]);
    const row=tracker.current(p.id)!;
    assert.equal(row.attempts.pending,scenario==='awaiting-inspect'?1:0,scenario);
    assert.equal(row.attempts.unknown,scenario==='awaiting-inspect'?0:1,scenario);
    assert.equal(row.attempts.zeroFill,0);assert.equal(tracker.confirm(op.id,1200),false);
    assert.deepEqual(row.confirmed,{long:scenario==='awaiting-inspect'?0:null,short:0});
  }
});

test('an active Maker marker cannot conceal missing native identity or an unknown activity state',t=>{
  const {tracker,tick}=setup(t),p=position();tracker.begin(begin());const maker=order('long','maker');
  maker.request.postOnly=true;maker.result!.status='unknown';maker.result!.id='';maker.result!.filledQuantity=0;
  maker.makerReduction={activity:'active',makerLeg:'long',deadlineAt:6000};tick(1100);tracker.orderSubmitted(p,maker);
  tick(1200);tracker.observe(p,[maker]);assert.equal(tracker.current(p.id)!.attempts.pending,0);assert.equal(tracker.current(p.id)!.attempts.unknown,1);
  maker.result!.id='native-maker';maker.makerReduction.activity='unknown';tracker.observe(p,[maker]);
  assert.equal(tracker.current(p.id)!.attempts.pending,0);assert.equal(tracker.current(p.id)!.attempts.unknown,1);
});

test('terminal Maker confirmation clears pending and only complete target accounting can finish the operation',t=>{
  const {tracker,tick}=setup(t),p=position(),op=tracker.begin(begin())!,maker=order('long','maker'),peer=order('short','peer');
  maker.request.postOnly=true;maker.makerReduction={activity:'active',makerLeg:'long',deadlineAt:6000};
  tick(1100);[maker,peer].forEach(order=>tracker.orderSubmitted(p,order));tick(1200);tracker.observe(p,[maker,peer]);
  assert.equal(tracker.current(p.id)!.attempts.pending,1);assert.equal(tracker.confirm(op.id,1200),false);
  maker.makerReduction.activity='terminal';tick(1300);tracker.observe(p,[maker,peer]);assert.equal(tracker.current(p.id)!.attempts.pending,0);
  tick(1400);assert.equal(tracker.confirm(op.id,1400),true);
});

test('manual deadline is recorded when the real processing window starts and expiry does not resolve an order',t=>{
  const {tracker,tick}=setup(t),op=tracker.begin(begin({origin:'manual',kind:'manual-close'}))!;
  assert.equal(tracker.current('position')!.windowEndsAt,undefined);tick(5000);tracker.window(op.id,35_000);
  assert.equal(tracker.current('position')!.windowEndsAt,35_000);tracker.window(op.id,NaN);tracker.window(op.id,500);
  assert.equal(tracker.current('position')!.windowEndsAt,35_000);tick(36_000);
  assert.equal(tracker.current('position')!.state,'running');assert.equal(tracker.snapshot().counts.complete,0);
});

test('tiny unfilled targets retain their exact remaining quantity and cannot be confirmed complete',t=>{
  const {tracker,tick}=setup(t),p=position();const op=tracker.begin(begin({target:{long:1e-18,short:1e-18}}))!;
  const zero=order('long','tiny',1e-18);zero.result!.status='cancelled';zero.result!.filledQuantity=0;zero.result!.feeUsd=0;
  zero.result!.averagePrice=0;tick(1100);tracker.orderSubmitted(p,zero);tick(1200);tracker.observe(p,[zero]);
  assert.deepEqual(tracker.current(p.id)!.remaining,{long:1e-18,short:1e-18});assert.equal(tracker.confirm(op.id,1200),false);
});

test('ending a partial manual window releases current identity and preserves fixed end time',t=>{
  const {tracker,tick}=setup(t),op=tracker.begin(begin({origin:'manual',kind:'manual-close'}))!;
  tick(1500);tracker.end(op.id,'partial',{code:'window-ended',text:'本次窗口结束，剩余数量等待确认'});
  tick(5000);assert.equal(tracker.current('position'),undefined);
  assert.equal(tracker.snapshot().rows[0].endedAt,1500);assert.equal(tracker.snapshot().pendingAgeMs.knownCount,0);
  assert.equal(tracker.confirm(op.id,5000),false);
});

test('entry rollback reduces confirmed operation quantity instead of counting a compensation as target progress',t=>{
  const {tracker,tick}=setup(t),p=position();tracker.begin(begin({kind:'entry',protocol:'ioc'}));
  const initial=order('long','entry',2,1100,false),rollback=order('long','rollback',1,1200,true);
  tick(1100);tracker.orderSubmitted(p,initial);tick(1200);tracker.orderSubmitted(p,rollback);
  tick(1300);tracker.observe(p,[initial,rollback]);
  assert.deepEqual(tracker.current(p.id)!.confirmed,{long:1,short:0});assert.deepEqual(tracker.current(p.id)!.remaining,{long:1,short:2});
});

test('local veto and terminal-zero are distinct from a completed close and missing fees stay unknown',t=>{
  const {tracker,tick}=setup(t),p=position();tracker.begin(begin());const veto=order('long','veto');
  veto.result={id:'',clientOrderId:'veto',status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:1110,rejectionCode:'INVALID_ORDER_QUANTITY'};
  const zero=order('short','zero');zero.result!.status='cancelled';zero.result!.filledQuantity=0;zero.result!.averagePrice=0;zero.result!.feeUsd=0;
  tick(1100);[veto,zero].forEach(o=>tracker.orderSubmitted(p,o));tick(1200);tracker.observe(p,[veto,zero]);
  assert.equal(tracker.current(p.id)!.attempts.preflightNotSent,1);assert.equal(tracker.current(p.id)!.attempts.zeroFill,1);
  assert.equal(tracker.snapshot().counts.complete,0);assert.equal(tracker.snapshot().timing.ackToFirstFillMs.knownCount,0);
  zero.result!.feeUsd=NaN;tracker.observe(p,[veto,zero]);assert.equal(tracker.current(p.id)!.attempts.unknown,1);
});

test('restart retains interrupted evidence without inventing an ending clock or resuming current order ownership',t=>{
  const {tracker,path,tick}=setup(t);const op=tracker.begin(begin())!;paired(tracker,tick);tracker.flush();
  const restored=new TradingOperationTracker(path,{now:()=>1500,debounceMs:60_000});t.after(()=>restored.dispose());
  const row=restored.snapshot().rows.find(row=>row.id===op.id)!;
  assert.equal(row.state,'unknown');assert.equal(row.endedAt,undefined);assert.equal(row.updatedAt,1200);
  assert.equal(restored.current('position'),undefined);assert.equal(restored.confirm(op.id,1500),false);
  const unknownBefore=structuredClone(row);restored.observe(position(),[order('long','long'),order('short','short')]);
  assert.deepEqual(restored.snapshot().rows[0],unknownBefore);
});

test('corrupt sidecar remains untouched and diagnostics never throw through the financial operation',t=>{
  const {path}=setup(t),source='{broken-json';writeFileSync(path+'.operations.json',source);
  const tracker=new TradingOperationTracker(path,{now:()=>2000,debounceMs:60_000});t.after(()=>tracker.dispose());
  assert.doesNotThrow(()=>tracker.begin(begin()));assert.doesNotThrow(()=>tracker.flush());
  assert.equal(readFileSync(path+'.operations.json','utf8'),source);assert.match(tracker.snapshot().diagnosticError!,/无法完整校验/);
  assert.equal(tracker.snapshot().coverageLimited,true);
});

test('filesystem write failure reports missing diagnostic persistence while preserving in-memory observations',t=>{
  const {path}=setup(t);
  const tracker=new TradingOperationTracker(path,{now:()=>2000,debounceMs:60_000});t.after(()=>tracker.dispose());
  mkdirSync(path+'.operations.json');
  assert.doesNotThrow(()=>tracker.begin(begin()));assert.doesNotThrow(()=>tracker.flush());
  assert.match(tracker.snapshot().diagnosticError!,/写入失败/);assert.equal(tracker.snapshot().counts.total,1);
});

test('retention bounds completed operations, preserves unfinished records, and declares the coverage boundary',t=>{
  const {tracker,tick}=setup(t,{endedLimit:1,hardLimit:3});
  const old=tracker.begin(begin())!;tick(1100);tracker.end(old.id,'cancelled');
  const newer=tracker.begin(begin())!;tick(1200);tracker.end(newer.id,'failed');
  const running=tracker.begin(begin())!;tick(1300);tracker.begin(begin({origin:'manual',kind:'manual-close'}));
  assert.equal(tracker.snapshot().rows.some(row=>row.id===old.id),false);
  assert.equal(tracker.snapshot().rows.some(row=>row.id===running.id),true);assert.equal(tracker.snapshot().coverageLimited,true);
  assert.equal(tracker.begin(begin({origin:'manual',kind:'manual-close'})),undefined);
  assert.equal(tracker.snapshot().counts.total,3);
});

test('attach moves a not-yet-submitted entry to its real position without changing bound order scope',t=>{
  const {tracker,tick}=setup(t),p=position();const op=tracker.begin(begin({positionId:'pre-entry',kind:'entry',protocol:'ioc'}))!;
  tracker.attach(op.id,p.id,{long:3,short:3});assert.equal(tracker.current('pre-entry'),undefined);
  tick(1100);tracker.orderSubmitted(p,order('long','new-entry',3,1100,false));
  tracker.attach(op.id,p.id,{long:999,short:999});assert.deepEqual(tracker.current(p.id)!.target,{long:3,short:3});
});

test('explicit automatic rescue evidence is retained while a normal manual submission is not a failure',t=>{
  const {tracker,tick}=setup(t),auto=tracker.begin(begin())!;tick(1100);tracker.intervene(auto.id,'recovery','audit-1');
  const manual=tracker.begin(begin({origin:'manual',kind:'manual-close'}))!;tracker.intervene(manual.id,'recovery','audit-2');
  assert.equal(tracker.snapshot().counts.intervention,1);assert.equal(tracker.snapshot().counts.manual,1);
});
