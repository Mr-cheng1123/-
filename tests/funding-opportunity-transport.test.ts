import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFundingOpportunitiesTransport,decodeFundingOpportunitiesTransport} from '../src/shared/funding-opportunity-transport.js';
import {fundingPairKey,type FundingCandidateView,type FundingOpportunitiesResponse} from '../src/shared/funding-opportunities.js';

const wire=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const pendingReasons=['实时可成交多空价格与账户余额待核验','资金费与可成交价差同向待核验'];
function dataset(count=80):FundingOpportunitiesResponse {
  return {
    source:'exchanges',status:'ready',receivedAt:1790912000000,maxAgeMs:120000,computedAt:1790912000100,
    coinCount:count,pairCount:count,verificationLimit:6,
    rows:Array.from({length:count},(_,index)=>({
      id:`COIN${index}-gate-bitget`,base:`COIN${index}`,longExchange:'gate',shortExchange:'bitget',
      longRate:-.00001385,shortRate:.00052345,longIntervalHours:1,shortIntervalHours:8,
      nextFundingTime:1790913600000,exitTime:1790913601000,longFundingCount:1,shortFundingCount:1,
      grossFundingUsd:.05373,notionalUsd:100,normalized8hBps:6.3425,aprPct:69.450375,
      feesUsd:NaN,afterFeesUsd:NaN,expectedNetUsd:NaN,slippageBudgetUsd:0,transferCostUsd:0,fundingHaircutUsd:0,basisReserveUsd:0,
      candidateEligible:true,updatedAt:1790912000000,reasons:[...pendingReasons],verification:'pending',
      pairKey:fundingPairKey({base:`COIN${index}`,longExchange:'gate',shortExchange:'bitget'}),
    })),
    coverage:{statisticsCoinCount:count+1,pairedCoinCount:count,unpairedCoinCount:1,detailedPairCount:0,
      unpaired:[{base:'MISSING',validExchanges:['gate'],reason:'仅一家交易所有当前有效费率与下一次结算时间'}]},
    autoVerification:{enabled:true,running:true,batchSize:8,totalCoins:count,checkedCoins:count-1,freshCoins:4,
      pendingCoins:1,failedCoins:0,activeCoins:['COIN2'],lastBatchAt:1790912000000,nextBatchAt:1790912001000},
  };
}

test('compact transport exactly preserves the full JSON response, including unknown fees and current detail',()=>{
  const original=dataset();
  Object.assign(original.rows[3],{
    verification:'blocked',candidateEligible:false,feesUsd:.12221987,afterFeesUsd:-.06848987,
    verifyNote:'盘口过期',executionObservedAt:1790911990000,
    execution:{id:original.rows[3].id,eligible:false,entryReady:false,feesSource:'exchange',longObservedAt:1790911990000,
      entryLimitPriceEdgeBps:null,entryLimitNetUsd:NaN,checks:[{group:'execution',pass:null,label:'等待盘口',reason:'尚未同步'}]},
    statistics:{id:original.rows[3].id,feesUsd:NaN,nextFundingTime:1790913600000},
  });
  const decoded=decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(original)));
  assert.deepEqual(decoded,wire(original));
  assert.equal(decoded.rows[0].feesUsd,null);
  assert.equal(decoded.rows[3].execution?.entryReady,false);
  assert.equal(decoded.rows[3].execution?.checks?.[0].pass,null);
  assert.equal(decoded.rows[3].feesUsd,.12221987);
  assert.ok(Number.isNaN(original.rows[0].feesUsd));
  assert.deepEqual(original.rows[0].reasons,pendingReasons);
});

test('standalone snapshots preserve row deletions, direction reversals and ordering without prior client state',()=>{
  const original=dataset(3),reversed={...original.rows[2],id:'COIN2-bitget-gate',longExchange:'bitget',shortExchange:'gate',directionChanged:true,
    longRate:original.rows[2].shortRate,shortRate:original.rows[2].longRate} as FundingCandidateView;
  const next={...original,computedAt:original.computedAt+5000,rows:[reversed,original.rows[0]],pairCount:2};
  const decoded=decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(next)));
  assert.deepEqual(decoded,wire(next));
  assert.equal(decoded.rows[0].pairKey,original.rows[2].pairKey);
  assert.equal(decoded.rows[0].id,'COIN2-bitget-gate');
  assert.equal(decoded.rows.some(row=>row.base==='COIN1'),false);
});

test('compact and original empty/error snapshots remain compatible and do not retain old rows',()=>{
  const full=wire(dataset(0));assert.equal(decodeFundingOpportunitiesTransport(full),full);
  const unavailable={...full,status:'error',message:'数据源暂时不可用'} as FundingOpportunitiesResponse;
  assert.deepEqual(decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(unavailable))),unavailable);
});

test('bounded public diagnostics travel with their own opportunity response without changing rows or eligibility',()=>{
  const original=dataset(2),before=wire(original.rows),at=original.computedAt;
  original.autoVerification!.diagnostics={sampleLimit:32,sampleCount:1,totalBatches:1,queuedCoins:1,oldestQueuedAt:at-100,
    queueWaitP95Ms:80,readP95Ms:30,publishP95Ms:0,recentBatches:[{sequence:1,selectedAt:at-40,finishedAt:at,publishStartedAt:at,publishedAt:at,outcome:'published',
      reads:[{exchange:'gate',startedAt:at-40,finishedAt:at-10,outcome:'returned'}],routes:[{id:'COIN0-gate-bitget',base:'COIN0',longExchange:'gate',shortExchange:'bitget',
        queuedAt:at-120,selectedAt:at-40,selectionReason:'fair-rotation',missingExchanges:['bitget']}]}]};
  const decoded=decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(original)));
  assert.deepEqual(decoded.autoVerification!.diagnostics,wire(original.autoVerification!.diagnostics));assert.deepEqual(decoded.rows,before);
  assert.equal(decoded.rows[0].verification,'pending');assert.equal(decoded.computedAt,at);
  const old=decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(dataset(2))));
  assert.equal(old.autoVerification!.diagnostics,undefined,'an old payload remains valid and cannot inherit another response diagnostics');
});

test('optional absent fields, explicit null, zero, false and new fields keep their JSON meaning',()=>{
  const original=dataset(3);
  Object.assign(original.rows[0],{futureField:undefined,verifyNote:undefined});
  Object.assign(original.rows[1],{futureField:null,verifyNote:''});
  Object.assign(original.rows[2],{futureField:{x:false,y:0,z:null},feeUsd:0,candidateEligible:false});
  Object.assign(original,{futureMetadata:{precision:'unchanged'}});
  const decoded=decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(original)));
  assert.deepEqual(decoded,wire(original));
  assert.equal(Object.hasOwn(decoded.rows[0],'futureField'),false);
  assert.equal(Object.hasOwn(decoded.rows[1],'futureField'),true);
});

test('dictionary values reduce repeated data and do not alias mutable reasons between rows',()=>{
  const full=dataset(),packed=wire(encodeFundingOpportunitiesTransport(full));
  assert.ok(JSON.stringify(packed).length<JSON.stringify(full).length*.6);
  assert.ok(packed.columns.find(column=>column.name==='reasons')?.dictionary);
  const decoded=decodeFundingOpportunitiesTransport(packed);
  decoded.rows[0].reasons.push('仅修改第一条');
  assert.deepEqual(decoded.rows[1].reasons,pendingReasons);
  assert.deepEqual(full.rows[0].reasons,pendingReasons);
});

test('dictionary values cannot confuse string, number, object or nonfinite JSON representations',()=>{
  const full=dataset(100);
  full.rows.forEach((row,index)=>Object.assign(row,{future:[1,'1',null,NaN,'object:{"x":1}',{x:1}][index%6]}));
  assert.deepEqual(decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(full))),wire(full));
});

test('malformed compact responses reject instead of producing misleading opportunity evidence',()=>{
  const packed=wire(encodeFundingOpportunitiesTransport(dataset()));
  for(const input of [null,{},[],{format:'future-version',rows:[]}, {...packed,columns:[{name:'same'},{name:'same'}]},
    {...packed,metadata:{...packed.metadata,rows:[]}}, {...packed,values:[[]]},
    {...packed,columns:[{name:'candidateEligible',dictionary:[true,false]}],values:[[-1]]},
    {...packed,columns:[{name:'candidateEligible',dictionary:[true,false]}],values:[[2]]},
    {...packed,columns:[{name:'candidateEligible',dictionary:[true,false]}],values:[[.5]]},
    {...packed,columns:[{name:'candidateEligible'}],values:[[false,{candidateEligible:true}]]},
  ])assert.throws(()=>decodeFundingOpportunitiesTransport(input),/格式无效/);
});

test('special object property names remain data without changing decoded prototypes',()=>{
  const full=dataset(2);
  for(const row of full.rows)Object.defineProperty(row,'__proto__',{value:{injected:'no'},enumerable:true});
  const decoded=decodeFundingOpportunitiesTransport(wire(encodeFundingOpportunitiesTransport(full)));
  assert.deepEqual(decoded,wire(full));
  assert.equal(Object.getPrototypeOf(decoded.rows[0]),Object.prototype);
  assert.equal(({} as Record<string,unknown>).injected,undefined);
});
