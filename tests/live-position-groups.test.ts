import test from 'node:test';
import assert from 'node:assert/strict';
import {groupLivePositions,type LivePositionRow} from '../web/src/live-position-groups.js';
import type {ExchangeId,Position} from '../src/shared/types.js';
import {accountPositionKey} from '../web/src/account-position-identity.js';

const row=(base:string,exchange:ExchangeId,side:'long'|'short',quantity=100,symbol=`${base}/USDT:USDT`,suffix=''):LivePositionRow=>({
  base,exchange,side,quantity,symbol,rowKey:JSON.stringify([exchange,symbol,side,suffix]),markPrice:1,liquidationPrice:0,leverage:2});
const ledger=(id:string,long:LivePositionRow,short:LivePositionRow):Position=>({id,base:long.base,mode:'live',status:'open',openedAt:1,plannedExitAt:100,
  holdMode:'adaptive',long:{...long,entryPrice:1,feesUsd:0,liquidationDistancePct:50},short:{...short,entryPrice:1,feesUsd:0,liquidationDistancePct:50},
  fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]});

test('real account legs are adjacent in A-Z groups, followed by A-Z unpaired holdings',()=>{
  const rows=[row('SAFE','bybit','long'),row('DRIFT','bybit','long'),row('DGAI','bybit','long'),row('BASED','bybit','long'),row('SIREN','bybit','short'),
    row('ARK','gate','long'),row('DGAI','gate','short'),row('BASED','gate','short'),row('ONE','gate','long'),row('EDGE','gate','long'),
    row('DRIFT','bitget','short'),row('SIREN','bitget','long'),row('ARK','bitget','short'),row('SAFE','bitget','short')];
  const before=structuredClone(rows),groups=groupLivePositions(rows,[]);
  assert.deepEqual(groups.map(group=>[group.base,group.paired,group.rows.length]),[
    ['ARK',true,2],['BASED',true,2],['DGAI',true,2],['DRIFT',true,2],['SAFE',true,2],['SIREN',true,2],['EDGE',false,1],['ONE',false,1]]);
  for(const group of groups.filter(group=>group.paired))assert.deepEqual(group.rows.map(r=>r.side),['long','short']);
  assert.deepEqual(rows,before);assert.equal(groups.flatMap(group=>group.rows).length,14);
});

test('exact active strategy mapping takes priority over closest quantities and consumes each row once',()=>{
  const long=row('ARK','gate','long',100),wrongShort=row('ARK','bybit','short',100),mappedShort=row('ARK','bitget','short',90);
  const record=ledger('strategy',long,mappedShort),rows=[wrongShort,mappedShort,long],before=structuredClone({rows,record});
  const groups=groupLivePositions(rows,[record,structuredClone(record)]);
  assert.equal(groups[0].source,'ledger');assert.deepEqual(groups[0].rows.map(r=>r.exchange),['gate','bitget']);
  assert.equal(groups[1].rows[0],wrongShort);assert.equal(new Set(groups.flatMap(group=>group.rows)).size,3);
  assert.deepEqual({rows,record},before);
});

test('different contract symbols do not satisfy a local strategy leg merely sharing its ticker',()=>{
  const long=row('ARK','gate','long',100),alias=row('ARK','bitget','short',100,'ARKUSDT'),short=row('ARK','bybit','short',100);
  const record=ledger('strict-symbol',long,{...alias,symbol:'ARK/USDT:USDT'}),groups=groupLivePositions([alias,long,short],[record]);
  assert.equal(groups[0].source,'account');assert.deepEqual(groups[0].rows.map(r=>r.exchange),['gate','bitget']);
});

test('archived or closed records do not revive or override present account-only pairings',()=>{
  const long=row('ARK','gate','long'),short=row('ARK','bitget','short'),archived=ledger('old',long,short);
  archived.accountClosure={confirmedAt:10,reason:'historical flat',historicalOrdersPending:false};
  for(const record of [archived,{...ledger('closed',long,short),status:'closed' as const}]){
    const groups=groupLivePositions([short,long],[record]);assert.equal(groups.length,1);assert.equal(groups[0].source,'account');
    assert.equal(groups[0].paired,true);
  }
});

test('known distinct EDGE assets and unresolved HANMI mappings remain unpaired even with an old ledger pair',()=>{
  for(const [base,a,b] of [['EDGE','gate','bybit'],['HANMI','gate','bitget']] as const){
    const long=row(base,a,'long'),short=row(base,b,'short'),groups=groupLivePositions([long,short],[ledger('invalid',long,short)]);
    assert.equal(groups.length,2);assert.ok(groups.every(group=>!group.paired));
  }
});

test('same exchange, same direction and nonpositive quantities cannot become a cross-venue display pair',()=>{
  const rows=[row('ONE','gate','long'),row('ONE','gate','short'),row('ONE','bybit','long'),row('BAD','bitget','short',0),row('BAD','gate','long',NaN)];
  const groups=groupLivePositions(rows,[]);assert.equal(groups.length,2);
  assert.equal(groups[0].paired,true);assert.deepEqual(groups[0].rows.map(r=>r.exchange),['bybit','gate']);
  assert.equal(groups[1].paired,false);assert.equal(groups[1].rows[0].side,'long');
  const sameVenue=groupLivePositions(rows.slice(0,2),[]);assert.ok(sameVenue.every(group=>!group.paired));
});

test('several holdings of one coin form deterministic disjoint pairs despite arrival order',()=>{
  const rows=[row('ARK','gate','long',100),row('ARK','bybit','long',20),row('ARK','bitget','short',19),row('ARK','okx','short',105)];
  const groups=groupLivePositions(rows,[]),reversed=groupLivePositions(rows.slice().reverse(),[]);
  assert.deepEqual(groups,reversed);assert.equal(groups.length,2);
  assert.deepEqual(groups.map(group=>group.rows.map(r=>r.quantity)),[[20,19],[100,105]]);
});

test('an explicitly mapped margin partition wins over an equally sized same-side account row',()=>{
  const isolated={...row('ONE','gate','long'),marginMode:'isolated' as const};
  const crossed={...row('ONE','gate','long'),marginMode:'crossed' as const};
  isolated.rowKey=accountPositionKey('gate',isolated);crossed.rowKey=accountPositionKey('gate',crossed);
  const short=row('ONE','bitget','short'),record=ledger('strategy-isolated',isolated,short);
  record.long.accountPositionKey=isolated.rowKey;
  const groups=groupLivePositions([crossed,short,isolated],[record]);
  assert.equal(groups.length,2);assert.equal(groups[0].source,'ledger');
  assert.equal(groups[0].rows[0],isolated);assert.equal(groups[1].rows[0],crossed);
  assert.equal(new Set(groups.flatMap(group=>group.rows)).size,3);
});
