import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {defaultConfig} from '../src/shared/config.js';
import {summarizePerformanceRows} from '../src/shared/performance-aggregation.js';
import type {PerformanceRow} from '../src/shared/performance-types.js';
import type {AppState,Position} from '../src/shared/types.js';
import {accountPositionKey} from '../web/src/account-position-identity.js';
import {overviewPerformance} from '../web/src/overview-performance.js';
import OverviewPerformance from '../web/src/OverviewPerformance.js';

const now=1_000_000;
const position=():Position=>({id:'held',base:'SAND',mode:'live',status:'attention',openedAt:1000,
  plannedExitAt:2_000_000,holdMode:'adaptive',fundingUsd:3,feesUsd:.2,transferCostUsd:.05,
  spreadPnlUsd:999,realizedSpreadPnlUsd:.5,netPnlUsd:999,deltaUsd:0,fundingEvents:[],riskReasons:['管理暂停'],
  long:{exchange:'bitget',symbol:'SAND/USDT:USDT',side:'long',quantity:10,entryPrice:1,markPrice:99,feesUsd:.1,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'SAND/USDT:USDT',side:'short',quantity:10,entryPrice:1.1,markPrice:99,feesUsd:.1,liquidationDistancePct:null}});
const row=(id:string,category:PerformanceRow['category'],overrides:Partial<PerformanceRow>={}):PerformanceRow=>({
  id,base:id==='held'?'SAND':id.toUpperCase(),category,reason:'已确认双腿',closed:false,openedAt:1000,
  fundingUsd:3,feesUsd:.2,transferCostUsd:.05,spreadPnlUsd:999,netPnlUsd:999,...overrides});
const state=():AppState=>({timestamp:now,config:{...structuredClone(defaultConfig),mode:'live',dataSource:'public'},
  running:true,autoEnabled:false,liveUnlocked:false,killSwitch:false,opportunities:[],snapshots:[],exchanges:[],logs:[],equity:[{timestamp:10,netPnlUsd:9999,feesUsd:9999,fundingUsd:9999}],
  positions:[position()],risk:{status:'healthy',reasons:[]},totals:{netPnlUsd:9999,fundingUsd:9999,feesUsd:9999,spreadPnlUsd:9999,
    grossExposureUsd:0,availableBalanceUsd:null,openPositions:1},
  performance:summarizePerformanceRows([
    row('held','normal'),row('btr','normal',{closed:true,closedAt:10_000,fundingUsd:.06,feesUsd:.32,transferCostUsd:0,spreadPnlUsd:-.04,netPnlUsd:-.3}),
    row('ct','abnormal',{closed:true,closedAt:20_000,fundingUsd:0,feesUsd:.12,transferCostUsd:0,spreadPnlUsd:-.34,netPnlUsd:-.46}),
    row('ark','pending',{reason:'平仓成交尚未完整确认',fundingUsd:.22,feesUsd:.15,spreadPnlUsd:null,netPnlUsd:null}),
    row('one','external',{reason:'账户手动減仓，开仓历史缺失',fundingUsd:null,feesUsd:.13,spreadPnlUsd:null,netPnlUsd:null}),
  ],now),
  livePortfolio:{timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:(['bitget','bybit'] as const).map((exchange,index)=>({
    exchange,credentialsConfigured:true,status:'ready',requestedAt:now-100,receivedAt:now-50,
    positions:[{base:'SAND',symbol:'SAND/USDT:USDT',side:index?'short':'long',quantity:10,entryPrice:1,markPrice:1,
      liquidationPrice:0,leverage:2,unrealizedPnlUsd:index?-1:2,realizedPnlUsd:999,fundingUsd:999,feesUsd:999}]}))}});
const near=(actual:number|null|undefined,expected:number)=>assert.ok(typeof actual==='number'&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

function reviewedDos():Position {
  const p=position();p.id='d0000000-0000-4000-8000-000000000001';p.base='DOS';p.openedAt=1700000000000;
  p.long.exchange='bitget';p.long.symbol='DOS/USDT:USDT';p.short.exchange='gate';p.short.symbol='DOS/USDT:USDT';
  return p;
}

test('old API DOS classification is corrected before totals, tables and the closed normal curve are rendered',()=>{
  const s=state(),dos=reviewedDos();s.positions=[dos];s.livePortfolio=undefined;s.config.feeRebatePct={gate:70,bitget:50};
  const loss={...s.performance!.rows.find(item=>item.id==='btr')!,estimatedFeeRebateUsd:.1,estimatedNetPnlAfterRebateUsd:-.2};
  const oldDos=row(dos.id,'normal',{base:'DOS',openedAt:dos.openedAt,fundingUsd:.23,feesUsd:.11,
    spreadPnlUsd:null,netPnlUsd:null,estimatedFeeRebateUsd:.07,estimatedNetPnlAfterRebateUsd:null});
  s.performance=summarizePerformanceRows([loss,oldDos],now);
  const before=structuredClone(s);assert.equal(s.performance.normal.netPnlUsd,null,'The old API reproduces the screenshot.');
  const view=overviewPerformance(s,now)!;
  assert.equal(view.normal.count,1);near(view.normal.netPnlUsd,-.3);near(view.normal.fundingUsd,.06);
  near(view.normal.feesUsd,.32);near(view.normal.estimatedFeeRebateUsd,.1);near(view.normal.estimatedNetPnlAfterRebateUsd,-.2);
  assert.equal(view.abnormal.count,1);near(view.abnormal.fundingUsd,.23);near(view.abnormal.feesUsd,.11);
  assert.equal(view.abnormal.netPnlUsd,null);assert.equal(view.rows.find(item=>item.id===dos.id)!.category,'abnormal');
  assert.deepEqual(s,before);near(view.closedNormalEquity.at(-1)!.netPnlUsd,-.3);
  const html=renderToStaticMarkup(createElement(OverviewPerformance,{state:s,renderEquity:()=>null}));
  const normal=html.match(/<details[^>]*data-performance-category="normal"[^>]*>[\s\S]*?<\/details>/)![0];
  const abnormal=html.match(/<details[^>]*data-performance-category="abnormal"[^>]*>[\s\S]*?<\/details>/)![0];
  assert.ok(!normal.includes('<b>DOS</b>'));assert.ok(abnormal.includes('<b>DOS</b>'));
  assert.match(html,/正常双腿策略 · 1 组/);assert.match(html,/ADL.*不计入正常策略收益/);
  assert.match(normal,/−\$0\.30/);assert.ok(!normal.includes('待完整核对'));
});

test('an active excluded DOS still guards account ownership for another normal lifecycle',()=>{
  const s=state(),dos=reviewedDos(),other={...structuredClone(dos),id:'another-DOS-lifecycle'};
  s.positions=[dos,other];s.performance=summarizePerformanceRows([dos,other].map(p=>row(p.id,'normal',{
    base:'DOS',openedAt:p.openedAt,estimatedFeeRebateUsd:.07,estimatedNetPnlAfterRebateUsd:999.07})),now);
  const view=overviewPerformance(s,now)!;
  assert.equal(view.normal.count,1);assert.equal(view.rows[0].category,'abnormal');
  assert.equal(view.rows[1].category,'normal');assert.equal(view.rows[1].netPnlUsd,null);
  assert.match(view.rows[1].reason,/多个策略记录对应同一账户仓位/);
  const unprovenClosed=structuredClone(s);unprovenClosed.positions[0].status='closed';
  assert.match(overviewPerformance(unprovenClosed,now)!.rows[1].reason,/多个策略记录对应同一账户仓位/,
    'A closed flag alone cannot release unresolved held quantities.');
  const confirmedClosed=structuredClone(s);confirmedClosed.performance!.rows[0].closed=true;
  assert.doesNotMatch(overviewPerformance(confirmedClosed,now)!.rows[1].reason,/多个策略记录对应同一账户仓位/);
  for(const confirmedAt of [0,NaN,now+1]){
    const invalidArchive=structuredClone(s);invalidArchive.positions[0].accountClosure={confirmedAt,reason:'未核验',historicalOrdersPending:false};
    assert.match(overviewPerformance(invalidArchive,now)!.rows[1].reason,/多个策略记录对应同一账户仓位/);
  }
  for(const release of [(p:Position)=>{p.accountClosure={confirmedAt:now,reason:'原生双空',historicalOrdersPending:false};},
    (p:Position)=>{p.long.quantity=0;p.short.quantity=0;}]){
    const next=structuredClone(s);release(next.positions[0]);
    assert.doesNotMatch(overviewPerformance(next,now)!.rows[1].reason,/多个策略记录对应同一账户仓位/);
  }
});

test('normal held valuation uses native UPL once and retains all confirmed lifecycle cash',()=>{
  const s=state(),before=structuredClone(s),view=overviewPerformance(s,now)!;
  const held=view.rows.find(item=>item.id==='held')!;
  near(held.spreadPnlUsd,1.5);near(held.netPnlUsd,4.25);near(held.fundingUsd,3);near(held.feesUsd,.2);near(held.transferCostUsd,.05);
  near(view.normal.netPnlUsd,3.95);near(view.normal.fundingUsd,3.06);near(view.normal.feesUsd,.52);near(view.abnormal.netPnlUsd,-.46);
  assert.equal(view.normal.count,2,'A paused normal strategy remains normal.');
  assert.deepEqual(s,before,'Valuation must not rewrite account observations, journal cash, permissions or lifecycle data.');
});

test('missing, stale, pre-action, wrong-cycle or wrong-quantity account evidence never borrows old marks',()=>{
  const changes:Array<(s:AppState)=>void>=[
    s=>{s.livePortfolio=undefined;},s=>{s.livePortfolio!.exchanges[1].requestedAt=now-15001;},
    s=>{s.livePortfolio!.exchanges[1].status='error';},s=>{s.livePortfolio!.exchanges[1].requestedAt=999;},
    s=>{s.livePortfolio!.exchanges[1].positions[0].positionOpenedAt=now-1000;},
    s=>{s.livePortfolio!.exchanges[1].positions[0].quantity=9;},
    s=>{delete s.livePortfolio!.exchanges[1].positions[0].unrealizedPnlUsd;},
    s=>{s.livePortfolio!.exchanges[0].positions[0].symbol='SAND/USDC:USDC';},
  ];
  for(const change of changes){const s=state();change(s);const view=overviewPerformance(s,now)!,held=view.rows[0];
    assert.equal(held.spreadPnlUsd,null);assert.equal(held.netPnlUsd,null);assert.equal(view.normal.netPnlUsd,null);
    near(view.normal.knownNetUsd,-.3);near(held.fundingUsd,3);near(held.feesUsd,.2);
    assert.match(held.reason,/等待.*账户价格损益/);near(view.abnormal.netPnlUsd,-.46);
  }
});

test('distinct native position identities may value separate strategies; duplicate claims cannot double count account UPL',()=>{
  const s=state(),second={...structuredClone(s.positions[0]),id:'held-two'};
  s.positions.push(second);s.performance=summarizePerformanceRows([...s.performance!.rows,row('held-two','normal')],now);
  const unknown=overviewPerformance(s,now)!;
  for(const id of ['held','held-two']){const entry=unknown.rows.find(item=>item.id===id)!;assert.equal(entry.netPnlUsd,null);assert.match(entry.reason,/同一账户仓位/);}
  for(let index=0;index<2;index++){
    const exchange=s.livePortfolio!.exchanges[index],original=exchange.positions[0];
    exchange.positions=[{...original,marginMode:'crossed'},{...original,marginMode:'isolated',unrealizedPnlUsd:index?-2:4}];
    s.positions[0][index?'short':'long'].accountPositionKey=accountPositionKey(exchange.exchange,exchange.positions[0]);
    second[index?'short':'long'].accountPositionKey=accountPositionKey(exchange.exchange,exchange.positions[1]);
  }
  const separate=overviewPerformance(s,now)!;
  near(separate.rows.find(item=>item.id==='held')!.spreadPnlUsd,1.5);
  near(separate.rows.find(item=>item.id==='held-two')!.spreadPnlUsd,2.5);
});

test('confirmed closed normal loss and its curve remain available without current account connection',()=>{
  const s=state();s.livePortfolio=undefined;s.positions=[];
  s.performance=summarizePerformanceRows([s.performance!.rows.find(item=>item.id==='btr')!,s.performance!.rows.find(item=>item.id==='ct')!],now);
  const view=overviewPerformance(s,now)!;near(view.normal.netPnlUsd,-.3);near(view.abnormal.netPnlUsd,-.46);
  assert.equal(view.closedNormalEquity.at(-1)!.netPnlUsd,-.3,'CT rollback loss must not enter the normal closed curve.');
});

test('paper records keep their classified paper valuation and absent API classification has no combined-data fallback',()=>{
  const s=state();s.positions[0].mode='paper';assert.equal(overviewPerformance(s,now)!.rows[0].netPnlUsd,999);
  delete s.performance;assert.equal(overviewPerformance(s,now),undefined);
});

test('overview renders independent CT costs and unknown cash explicitly, not as zero net',()=>{
  const s=state();s.livePortfolio!.timestamp=Date.now();for(const exchange of s.livePortfolio!.exchanges){exchange.requestedAt=Date.now()-100;exchange.receivedAt=Date.now()-50;}
  const charts:number[]=[];
  const html=renderToStaticMarkup(createElement(OverviewPerformance,{state:s,renderEquity:points=>{
    charts.push(points.at(-1)!.netPnlUsd);return createElement('div',{'data-chart-last':points.at(-1)!.netPnlUsd});
  }}));
  assert.match(html,/正常策略累计净收益/);assert.match(html,/\+\$3\.95/);assert.match(html,/异常交易与回滚/);
  assert.match(html,/−\$0\.46/);assert.match(html,/data-performance-category="pending"/);assert.match(html,/净损益待核对/);
  assert.match(html,/正常策略已平仓收益曲线/);assert.match(html,/不含当前未实现损益/);assert.match(html,/未扣预计平仓费/);
  assert.deepEqual(charts,[-.3]);assert.ok(!html.includes('$9,999.00'),'Old combined totals and equity must not leak into strategy performance.');
  assert.ok(!html.includes('已确认净损益'),'A wholly unknown net is not a zero subtotal.');
});

test('missing classification renders a sync message instead of previous totals or chart',()=>{
  const s=state();delete s.performance;let charts=0;
  const html=renderToStaticMarkup(createElement(OverviewPerformance,{state:s,renderEquity:()=>{charts++;return null;}}));
  assert.match(html,/等待策略统计同步/);assert.ok(!html.includes('$9,999.00'));assert.equal(charts,0);
});

test('ended historical pending records leave the current table but preserve their cash and original category',()=>{
  const s=state(),old={...position(),id:'old-pending'};old.accountClosure={confirmedAt:5000,reason:'原生双空',historicalOrdersPending:true};
  const current={...position(),id:'current-pending'};current.status='closed';current.long.quantity=0;current.short.quantity=0;
  s.positions=[old,current];s.unconfirmedOrders=[{positionId:old.id,exchange:'bitget',historical:true},
    {positionId:current.id,exchange:'bybit',historical:false}];
  s.performance=summarizePerformanceRows([row(old.id,'pending',{base:old.base,fundingUsd:.23,feesUsd:.11,netPnlUsd:null,spreadPnlUsd:null}),
    row(current.id,'pending',{base:current.base,fundingUsd:.45,feesUsd:null,netPnlUsd:null,spreadPnlUsd:null})],now);
  const before=structuredClone(s),html=renderToStaticMarkup(createElement(OverviewPerformance,{state:s,renderEquity:()=>null}));
  const groups=html.match(/<details[^>]*data-performance-category="pending"[^>]*>[\s\S]*?<\/details>/g)!;
  assert.equal(groups.length,2);const archive=groups.find(group=>group.includes('data-performance-history="archived"'))!;
  const active=groups.find(group=>!group.includes('data-performance-history="archived"'))!;
  assert.match(archive,/历史待核对（已归档）/);assert.match(archive,/data-performance-record="old-pending"/);
  assert.match(archive,/\+\$0\.23/);assert.match(archive,/\$0\.11/);assert.match(archive,/待核对/);
  assert.ok(!archive.includes('data-performance-record="current-pending"'));
  assert.match(active,/data-performance-record="current-pending"/);assert.ok(!active.includes('data-performance-record="old-pending"'));
  assert.deepEqual(s,before);assert.equal(s.performance.pending.count,2);assert.equal(s.performance.pending.feesUsd,null);
});

test('all held valuations unknown do not display a zero net as an already confirmed subtotal',()=>{
  const s=state();s.livePortfolio=undefined;
  s.performance=summarizePerformanceRows([s.performance!.rows[0]],now);
  const html=renderToStaticMarkup(createElement(OverviewPerformance,{state:s,renderEquity:()=>null}));
  assert.match(html,/1 组净收益待完整核对/);assert.ok(!html.includes('已确认部分 $0.00'));
  assert.match(html,/净损益待核对/);assert.ok(!html.includes('当前收益 $0.00'));
});

test('rebate projection follows fresh native UPL while original paid fees, cash totals and equity remain intact',()=>{
  const s=state();s.config.feeRebatePct={gate:70,bitget:50};
  s.performance=summarizePerformanceRows(s.performance!.rows.map(item=>({...item,
    estimatedFeeRebateUsd:.1,estimatedNetPnlAfterRebateUsd:item.netPnlUsd===null?null:item.netPnlUsd+.1})),now);
  const before=structuredClone(s),view=overviewPerformance(s,now)!;
  near(view.rows[0].netPnlUsd,4.25);near(view.rows[0].estimatedNetPnlAfterRebateUsd,4.35);
  near(view.normal.netPnlUsd,3.95);near(view.normal.estimatedFeeRebateUsd,.2);
  near(view.normal.estimatedNetPnlAfterRebateUsd,4.15);near(view.normal.feesUsd,.52);
  near(view.closedNormalEquity.at(-1)!.netPnlUsd,-.3);assert.deepEqual(s,before);
  const html=renderToStaticMarkup(createElement(OverviewPerformance,{state:s,renderEquity:()=>null}));
  assert.match(html,/预计返佣/);assert.match(html,/返佣后估算净收益/);assert.match(html,/未核对到账/);
});

test('stale account valuation keeps a known rebate estimate separate from an unknown adjusted net',()=>{
  const s=state();s.config.feeRebatePct={bitget:50};s.livePortfolio=undefined;
  s.performance=summarizePerformanceRows(s.performance!.rows.map(item=>({...item,
    estimatedFeeRebateUsd:.1,estimatedNetPnlAfterRebateUsd:123})),now);
  const view=overviewPerformance(s,now)!;
  assert.equal(view.rows[0].netPnlUsd,null);near(view.rows[0].estimatedFeeRebateUsd,.1);
  assert.equal(view.rows[0].estimatedNetPnlAfterRebateUsd,null);
  assert.equal(view.normal.estimatedNetPnlAfterRebateUsd,null);
});
