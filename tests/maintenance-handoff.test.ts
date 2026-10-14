import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import {assertManagedPositionsForHandoff,inspectMaintenanceHoldings,maintenanceHash,maintenanceLedgerHash,maintenancePositionPartition,verifyMaintenanceFundingReads,
  maintenanceVenueScope,restoreVerifiedMaintenanceHoldings,validateMaintenanceHandoff,type MaintenanceHandoff} from '../src/core/maintenance-handoff.js';
import type {SavedState,Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import type {AccountState,ExchangeAdapter,ExchangeId,Position} from '../src/shared/types.js';
import {sealPreviewMaintenanceHandoff,type PreviewMaintenanceHandoff} from '../src/core/preview-maintenance-handoff.js';

const now=Date.now(),project='D:/maintenance-fixture',venues:ExchangeId[]=['bybit','gate'];
function fixture(){
  const position:Position={id:'original',base:'BTR',mode:'live',entryPolicy:'aligned',status:'open',openedAt:now-60000,plannedExitAt:now+3600000,holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTR/USDT:USDT',side:'long',quantity:1990,entryPrice:.05,markPrice:.05,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTR/USDT:USDT',side:'short',quantity:1990,entryPrice:.0501,markPrice:.0501,feesUsd:.06,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.11,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:-.11,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const config=validateConfig({...defaultConfig,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',autoEnabled:false});
  const ledger:SavedState={version:1,config,positions:[position],orders:[],fundingSeen:[],logs:[],equity:[],killSwitch:false};
  const proof:MaintenanceHandoff={version:1,at:now,sourcePid:99,project,credentialsHash:'same-file-hash',ledgerHash:maintenanceLedgerHash(ledger),configHash:maintenanceHash(config),venues,positionIds:['original']};
  const calls:string[]=[];
  const accounts=new Map<ExchangeId,AccountState>(venues.map(exchange=>{const leg=exchange==='gate'?position.long:position.short;
    return [exchange,{freeUsd:500,equityUsd:600,positions:[{base:'BTR',symbol:leg.symbol,side:leg.side,quantity:leg.quantity,markPrice:.05,leverage:2,liquidationPrice:.025}]}];}));
  const clients=new Map(venues.map(exchange=>[exchange,{id:exchange,fetchAccount:async()=>{calls.push(`${exchange}:account`);return structuredClone(accounts.get(exchange)!);},
    fetchOpenOrders:async()=>{calls.push(`${exchange}:orders`);return [];},prepareTrading:async()=>{throw new Error('Financial mutation is forbidden');},
    placeOrder:async()=>{throw new Error('Financial mutation is forbidden');},cancelOrder:async()=>{throw new Error('Financial mutation is forbidden');},
    reconcileOrder:async()=>{throw new Error('Reconciliation may write; forbidden');}} as unknown as ExchangeAdapter]));
  return {position,config,ledger,proof,calls,accounts,clients};
}
test('handover is bound to exact project, credentials, financial journal, policy and existing venue scope',()=>{
  const f=fixture();const validate=(proof=f.proof)=>validateMaintenanceHandoff(proof,f.ledger,f.config,project,'same-file-hash',venues,now);
  assert.doesNotThrow(()=>validate());
  for(const patch of [{version:2},{at:now-120001},{at:now+5001},{sourcePid:0},{project:'D:/another-project'},
    {credentialsHash:'changed'},{ledgerHash:'changed'},{configHash:'changed'},{positionIds:['different']},{positionIds:['original','original']},{venues:[...venues,'bitget']}])
    assert.throws(()=>validate({...f.proof,...patch} as MaintenanceHandoff));
  f.position.long.quantity+=1;assert.throws(()=>validate());
});
test('runtime display updates do not invalidate receipts but any fees, funding or quantities do',()=>{
  const f=fixture(),initial=maintenanceLedgerHash(f.ledger);
  f.position.long.markPrice=.1;f.position.spreadPnlUsd=100;f.position.netPnlUsd=99;f.position.riskReasons=['restart reconciliation'];
  assert.equal(maintenanceLedgerHash(f.ledger),initial);
  f.position.feesUsd+=.001;assert.notEqual(maintenanceLedgerHash(f.ledger),initial);
});

test('a receipt preserves its exact session subset without authorizing another configured account',()=>{
  const f=fixture(),eligible:ExchangeId[]=['bitget','bybit','gate'];
  f.position.status='attention';
  const proof:MaintenanceHandoff={...f.proof,version:2,venues:['bitget','bybit'],positionIds:[],attentionPositionIds:['original']};
  const before=JSON.stringify(proof);
  assert.doesNotThrow(()=>validateMaintenanceHandoff(proof,f.ledger,f.config,project,'same-file-hash',eligible,now));
  assert.deepEqual(maintenanceVenueScope(proof.venues,eligible),['bitget','bybit']);assert.equal(JSON.stringify(proof),before);
  for(const invalid of [[],['bybit','bybit'],['bybit','okx'],['bybit','PRIVATE']])
    assert.throws(()=>validateMaintenanceHandoff({...proof,venues:invalid as ExchangeId[]},f.ledger,f.config,project,'same-file-hash',eligible,now));
  // Existing full-scope receipts remain valid, while expired or financially changed ones still fail.
  assert.doesNotThrow(()=>validateMaintenanceHandoff({...proof,venues:eligible},f.ledger,f.config,project,'same-file-hash',eligible,now));
  assert.throws(()=>validateMaintenanceHandoff({...proof,at:now-120001},f.ledger,f.config,project,'same-file-hash',eligible,now));
  f.position.fundingUsd=1;assert.throws(()=>validateMaintenanceHandoff(proof,f.ledger,f.config,project,'same-file-hash',eligible,now));
});

function scopedEngine(scope:readonly ExchangeId[],permission=true){
  const f=fixture();f.position.status='attention';f.config.exchanges=['bitget','bybit','gate'];
  const environment={ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    BITGET_API_KEY:'offline-key',BITGET_API_SECRET:'offline-secret',BITGET_PASSPHRASE:'offline-passphrase',
    BYBIT_API_KEY:'offline-key',BYBIT_API_SECRET:'offline-secret',GATE_API_KEY:'offline-key',GATE_API_SECRET:'offline-secret'};
  const store={data:f.ledger,save(){},log(){}} as unknown as Store;
  const engine=new Engine(store,permission,{liveEnvironment:environment,maintenanceExchanges:scope,adapterFactory:()=>[]});
  return {...f,engine};
}

test('a real Engine starts with only consumed proof venues while auto and all attention managers stay paused',async()=>{
  const scope:ExchangeId[]=['bitget','bybit'],f=scopedEngine(scope);
  assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,false);
  assert.deepEqual(f.engine.liveReadiness().exchanges.filter(e=>e.executionAuthorized).map(e=>e.exchange).sort(),['bitget','bybit']);
  const gate=f.engine.liveReadiness().exchanges.find(e=>e.exchange==='gate')!;
  assert.equal(gate.credentialsConfigured,true);assert.equal(gate.executionAuthorized,false);
  scope.push('gate');assert.equal(f.engine.liveReadiness().exchanges.find(e=>e.exchange==='gate')!.executionAuthorized,false,'Startup copies the receipt scope.');
  const proof:MaintenanceHandoff={...f.proof,version:2,venues:['bitget','bybit'],positionIds:[],attentionPositionIds:['original'],
    configHash:maintenanceHash(f.config),ledgerHash:maintenanceLedgerHash(f.ledger)};
  const before=maintenanceLedgerHash(f.ledger);
  assert.deepEqual(await restoreVerifiedMaintenanceHoldings(f.engine,proof),[]);
  assert.equal(f.position.status,'attention');assert.equal(f.engine.autoEnabled,false);assert.equal(maintenanceLedgerHash(f.ledger),before);
  assert.equal(f.engine.accounts.size,0,'Idle attention records cannot trigger private reads or manager restoration.');
});

test('maintenance startup refuses empty, duplicate, unavailable or unpermitted scopes and supports an existing single-venue scope',()=>{
  for(const scope of [[],['bybit','bybit'],['bybit','okx']])assert.throws(()=>scopedEngine(scope as ExchangeId[]),/scope is invalid/);
  assert.throws(()=>scopedEngine(['bybit'],false),/scope is invalid/);
  const f=scopedEngine(['bybit']);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,false);
  assert.deepEqual(f.engine.liveReadiness().exchanges.filter(e=>e.executionAuthorized).map(e=>e.exchange),['bybit']);
});

test('preview sealing preserves the exact paused source scope and accepts drained read-only funding observations',()=>{
  const f=fixture();f.position.status='attention';
  const source:PreviewMaintenanceHandoff={...f.proof,version:2,venues:['bybit'],positionIds:[],attentionPositionIds:['original'],
    sourceOrdersHash:maintenanceHash(f.ledger.orders)};
  f.position.fundingUsd=.2;f.position.long.fundingUsd=.2;f.position.fundingEvents.push('observed-funding');f.ledger.fundingSeen.push('observed-funding');
  const proof=sealPreviewMaintenanceHandoff(source,f.ledger,project,'same-file-hash',venues,true,now);
  assert.deepEqual(proof.venues,['bybit']);assert.deepEqual(proof.positionIds,[]);assert.equal(proof.ledgerHash,maintenanceLedgerHash(f.ledger));
  assert.equal('sourceOrdersHash' in proof,false);assert.doesNotThrow(()=>validateMaintenanceHandoff(proof,f.ledger,f.config,project,'same-file-hash',venues,now));
});

test('preview sealing rejects new intents, active manual work, a running source and old or changed receipts',()=>{
  for(const change of ['orders','manual-entry','manual-close','running','old','credentials','config','attention']){
    const f=fixture();f.position.status='attention';
    const source:PreviewMaintenanceHandoff={...f.proof,version:2,positionIds:[],attentionPositionIds:['original'],sourceOrdersHash:maintenanceHash(f.ledger.orders)};
    if(change==='orders')f.ledger.orders.push({positionId:'archived',createdAt:now,result:{status:'cancelled'}} as any);
    if(change==='manual-entry')f.ledger.manualEntryOperations=[{state:'preparing'} as any];
    if(change==='manual-close')f.ledger.manualCloseOperations=[{state:'checking'} as any];
    if(change==='old')source.at=now-120001;
    if(change==='config')f.config.leverage++;
    if(change==='attention')f.position.status='closed';
    assert.throws(()=>sealPreviewMaintenanceHandoff(source,f.ledger,project,change==='credentials'?'changed':'same-file-hash',venues,change!=='running',now),change);
  }
});

test('a subset receipt cannot restore a manager whose other leg lacks source authorization',async()=>{
  const f=fixture(),proof={...f.proof,venues:['gate'] as ExchangeId[]};
  assert.throws(()=>validateMaintenanceHandoff(proof,f.ledger,f.config,project,'same-file-hash',venues,now),/both managed legs/);
  const paused=engineFixture();paused.engine.liveReadiness=()=>({exchanges:[{exchange:'gate',executionAuthorized:true}]} as any);
  await assert.rejects(restoreVerifiedMaintenanceHoldings(paused.engine,{...paused.proof,venues:['gate']}),/both managed legs/);
  assert.equal(paused.position.status,'attention');assert.equal(paused.calls.length,0);
});
test('only fully matched open holdings can enter the controlled handover',()=>{
  for(const patch of [{status:'opening'},{status:'closing'},{status:'attention'},{mode:'paper'},{closeRequestedAt:now},{closeAttemptedAt:now}]){
    const f=fixture();Object.assign(f.position,patch);assert.throws(()=>assertManagedPositionsForHandoff(f.ledger.positions));
  }
  const f=fixture();f.position.short.quantity--;assert.throws(()=>assertManagedPositionsForHandoff(f.ledger.positions));
});
test('two independent account reads bracket a complete pending-order read; no financial method is called',async()=>{
  const f=fixture();const accounts=await inspectMaintenanceHoldings(f.ledger.positions,exchange=>f.clients.get(exchange)!);
  assert.equal(accounts.size,2);assert.equal(f.calls.length,6);
  for(const exchange of venues)assert.deepEqual(f.calls.filter(call=>call.startsWith(exchange)),[`${exchange}:account`,`${exchange}:orders`,`${exchange}:account`]);
});
test('missing, opposite, duplicate and changed holdings or pending orders prevent restoration',async()=>{
  for(const change of ['empty','opposite','duplicate','quantity','pending','late-change']){
    const f=fixture(),a=f.accounts.get('gate')!;
    if(change==='empty')a.positions=[];
    if(change==='opposite')a.positions[0].side='short';
    if(change==='duplicate')a.positions.push({...a.positions[0]});
    if(change==='quantity')a.positions[0].quantity--;
    if(change==='pending')f.clients.get('gate')!.fetchOpenOrders=async()=>[{} as any];
    if(change==='late-change')f.clients.get('gate')!.fetchOpenOrders=async()=>{a.positions[0].quantity--;return [];};
    await assert.rejects(inspectMaintenanceHoldings(f.ledger.positions,exchange=>f.clients.get(exchange)!));
  }
});
function engineFixture(){
  const f=fixture();f.position.status='attention';
  const engine={liveUnlocked:true,autoEnabled:false,config:f.config,store:{data:f.ledger,log:()=>{}},health:venues.map(exchange=>({exchange})),accounts:new Map(),
    exclusive:async(fn:()=>unknown)=>fn(),activePositions:()=>f.ledger.positions,
    adapter:(exchange:ExchangeId)=>f.clients.get(exchange)!,liveReadiness:()=>({exchanges:venues.map(exchange=>({exchange,executionAuthorized:true}))})} as unknown as Engine;
  return {...f,engine};
}
test('verified handover restores the original manager without changing policy, quantities, cash flows or auto entry',async()=>{
  const f=engineFixture();const before=maintenanceLedgerHash(f.ledger);
  assert.deepEqual(await restoreVerifiedMaintenanceHoldings(f.engine,f.proof),['original']);
  assert.equal(f.position.status,'open');assert.equal(f.position.holdMode,'adaptive');assert.equal(f.engine.autoEnabled,false);
  assert.equal(maintenanceLedgerHash(f.ledger),before);assert.equal(f.engine.accounts.size,2);assert.equal(f.calls.length,6);
});
test('failed read verification keeps the holding at attention and cannot enable a manager',async()=>{
  const f=engineFixture();f.clients.get('gate')!.fetchAccount=async()=>{throw new Error('read unavailable');};
  await assert.rejects(restoreVerifiedMaintenanceHoldings(f.engine,f.proof));assert.equal(f.position.status,'attention');assert.equal(f.engine.autoEnabled,false);
});
test('revoked permission, automatic entry, changed scope or changed financial records cannot use a receipt',async()=>{
  for(const change of ['permission','auto','scope','ledger']){
    const f=engineFixture();
    if(change==='permission')Object.defineProperty(f.engine,'liveUnlocked',{value:false});
    if(change==='auto')f.engine.autoEnabled=true;
    if(change==='scope')f.engine.liveReadiness=()=>({exchanges:[{exchange:'gate',executionAuthorized:true}]} as any);
    if(change==='ledger')f.position.fundingUsd=1;
    await assert.rejects(restoreVerifiedMaintenanceHoldings(f.engine,f.proof));assert.equal(f.position.status,'attention');assert.equal(f.calls.length,0);
  }
});
test('a halt or scope revocation during account reads cannot be undone by the handover',async()=>{
  for(const change of ['halt','scope']){
    const f=engineFixture();f.clients.get('gate')!.fetchOpenOrders=async()=>{
      if(change==='halt')f.ledger.killSwitch=true;
      else f.engine.liveReadiness=()=>({exchanges:[{exchange:'gate',executionAuthorized:true}]} as any);
      return [];
    };
    await assert.rejects(restoreVerifiedMaintenanceHoldings(f.engine,f.proof));assert.equal(f.position.status,'attention');
  }
});

function mixedFixture(){
  const f=fixture();
  const attention:Position={...structuredClone(f.position),id:'legacy-single-leg',base:'ONE',status:'attention',
    closeRequestedAt:now-30000,closeAttemptedAt:now-20000,riskReasons:['Original single leg remains paused'],
    long:{...f.position.long,symbol:'ONE/USDT:USDT',quantity:46600},
    short:{...f.position.short,exchange:'bitget',symbol:'ONE/USDT:USDT',quantity:0}};
  f.ledger.positions.push(attention);
  const proof:MaintenanceHandoff={...f.proof,version:2,...maintenancePositionPartition(f.ledger.positions),ledgerHash:maintenanceLedgerHash(f.ledger)};
  return {...f,attention,proof};
}
test('mixed source receipts identify only existing open managers and preserve unmatched attention records',()=>{
  const f=mixedFixture();
  assert.deepEqual(f.proof.positionIds,['original']);assert.deepEqual(f.proof.attentionPositionIds,['legacy-single-leg']);
  assert.doesNotThrow(()=>validateMaintenanceHandoff(f.proof,f.ledger,f.config,project,'same-file-hash',venues,now));
  for(const patch of [{positionIds:['original','legacy-single-leg'],attentionPositionIds:[]},
    {positionIds:['original'],attentionPositionIds:[]},{attentionPositionIds:['original','legacy-single-leg']},{attentionPositionIds:undefined}])
    assert.throws(()=>validateMaintenanceHandoff({...f.proof,...patch},f.ledger,f.config,project,'same-file-hash',venues,now));
  f.attention.status='open';assert.throws(()=>validateMaintenanceHandoff(f.proof,f.ledger,f.config,project,'same-file-hash',venues,now));
});
test('legacy receipts cannot start accepting attention records under the new source partition',()=>{
  const f=mixedFixture();
  assert.throws(()=>validateMaintenanceHandoff({...f.proof,version:1,positionIds:['original','legacy-single-leg']},f.ledger,f.config,project,'same-file-hash',venues,now));
  for(const status of ['opening','closing'] as const){f.attention.status=status;assert.throws(()=>maintenancePositionPartition(f.ledger.positions));}
});
test('version 2 financial binding includes all attention history and rejects unconfirmed current orders',()=>{
  for(const change of ['fee','funding','quantity','unknown-order']){
    const f=mixedFixture();
    if(change==='fee')f.attention.long.feesUsd+=.01;
    if(change==='funding')f.attention.fundingUsd+=1;
    if(change==='quantity')f.attention.long.quantity--;
    if(change==='unknown-order'){
      f.ledger.orders.push({positionId:f.attention.id,createdAt:now,result:{status:'unknown'}} as any);
      f.proof.ledgerHash=maintenanceLedgerHash(f.ledger);
    }
    assert.throws(()=>validateMaintenanceHandoff(f.proof,f.ledger,f.config,project,'same-file-hash',venues,now));
  }
});
function mixedEngineFixture(){
  const f=mixedFixture();f.position.status='attention';
  const engine={liveUnlocked:true,autoEnabled:false,config:f.config,store:{data:f.ledger,log:()=>{}},health:venues.map(exchange=>({exchange})),accounts:new Map(),
    exclusive:async(fn:()=>unknown)=>fn(),activePositions:()=>f.ledger.positions,
    adapter:(exchange:ExchangeId)=>{assert.ok(venues.includes(exchange),'Must not inspect unmanaged legacy venues');return f.clients.get(exchange)!;},
    liveReadiness:()=>({exchanges:venues.map(exchange=>({exchange,executionAuthorized:true}))})} as unknown as Engine;
  return {...f,engine};
}
test('mixed handover reads and restores only source open holdings; old attention records remain paused unchanged',async()=>{
  const f=mixedEngineFixture(),financialBefore=maintenanceLedgerHash(f.ledger),attentionBefore=structuredClone(f.attention);
  assert.deepEqual(await restoreVerifiedMaintenanceHoldings(f.engine,f.proof),['original']);
  assert.equal(f.position.status,'open');assert.deepEqual(f.attention,attentionBefore);
  assert.equal(maintenanceLedgerHash(f.ledger),financialBefore);assert.equal(f.calls.length,6);
  assert.equal(f.engine.autoEnabled,false);
});
test('changes to attention identities or status during managed reads prevent any restoration',async()=>{
  for(const change of ['remove','promote']){
    const f=mixedEngineFixture();f.clients.get('gate')!.fetchOpenOrders=async()=>{
      if(change==='remove')f.ledger.positions.pop();else f.attention.status='open';
      return [];
    };
    await assert.rejects(restoreVerifiedMaintenanceHoldings(f.engine,f.proof));assert.equal(f.position.status,'attention');
  }
});
test('post-reload verification independently replays only new funding receipts and preserves old attention cash',()=>{
  const f=mixedFixture(),before=structuredClone(f.ledger),after=structuredClone(before),payment={exchange:'gate' as const,id:'new-funding',base:'BTR',amountUsd:.2,timestamp:now};
  const p=after.positions[0];p.fundingUsd+=.2;p.long.fundingUsd=.2;p.long.lastFundingAt=now;p.fundingEvents.push('gate:new-funding');after.fundingSeen.push('gate:new-funding');
  assert.equal(verifyMaintenanceFundingReads(before,after,[payment],now),1);
  assert.throws(()=>verifyMaintenanceFundingReads(before,after,[],now));
  assert.throws(()=>verifyMaintenanceFundingReads(before,after,[{...payment,amountUsd:.1}],now));
  after.positions[1].feesUsd+=.01;assert.throws(()=>verifyMaintenanceFundingReads(before,after,[payment],now));
});
test('receipt replay rejects extra orders, deleted history and unrelated financial mutation',()=>{
  const f=fixture(),before=structuredClone(f.ledger);
  for(const change of ['order','quantity','history']){
    const after=structuredClone(before);
    if(change==='order')after.orders.push({positionId:'original',createdAt:now} as any);
    if(change==='quantity')after.positions[0].long.quantity--;
    if(change==='history'){before.fundingSeen=['old-receipt'];after.fundingSeen=[];}
    assert.throws(()=>verifyMaintenanceFundingReads(before,after,[],now));
  }
});

test('maintenance funding replay accepts an archived-cycle late receipt only with its original confirmed order timeline',()=>{
  const f=fixture(),p=f.position,settled=now-1000;
  p.status='attention';p.accountClosure={confirmedAt:now-500,reason:'flat account',historicalOrdersPending:false};
  const request={base:p.base,symbol:p.long.symbol,clientOrderId:'historical-fill',side:'buy' as const,reduceOnly:false,quantity:1990,limitPrice:.05};
  f.ledger.orders.push({positionId:p.id,exchange:'gate',request,createdAt:p.openedAt+1,
    result:{id:'original-fill',clientOrderId:request.clientOrderId,status:'filled',filledQuantity:1990,averagePrice:.05,feeUsd:.05,timestamp:p.openedAt+1}});
  const before=structuredClone(f.ledger),after=structuredClone(before),payment={exchange:'gate' as const,id:'late-archived-fund',base:p.base,symbol:p.long.symbol,side:'long' as const,quantity:1990,amountUsd:.2,timestamp:settled};
  const target=after.positions[0];target.fundingUsd+=.2;target.long.fundingUsd=.2;target.long.lastFundingAt=settled;
  target.fundingEvents.push('gate:late-archived-fund');after.fundingSeen.push('gate:late-archived-fund');
  assert.equal(verifyMaintenanceFundingReads(before,after,[payment],now),1);
  assert.throws(()=>verifyMaintenanceFundingReads(before,after,[{...payment,timestamp:now}],now));
  assert.deepEqual(after.positions[0].accountClosure,before.positions[0].accountClosure);
});
