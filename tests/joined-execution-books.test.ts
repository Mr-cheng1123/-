import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,NOW} from './native-exit-read-fixture.js';
import {quoteIsFresh} from '../src/core/market-validity.js';
import {SelectedPublicBookError} from '../src/core/selected-public-book-error.js';
import type {ExchangeId,MarketSnapshot,PrivateReadContext} from '../src/shared/types.js';

function selected(t:Parameters<typeof fixture>[0]){
  const f=fixture(t,{peerExchange:'bitget'}),counts=new Map<ExchangeId,number>(),cache=new Map<ExchangeId,MarketSnapshot>(),contexts:PrivateReadContext[]=[];
  const original=structuredClone(f.store.data.orders),cash=structuredClone(f.p);
  let hook:(exchange:ExchangeId,count:number,quote:MarketSnapshot)=>Promise<void>|void=()=>{},fees=0;
  for(const adapter of f.adapters){
    adapter.getExecutionSnapshot=()=>cache.get(adapter.id);
    adapter.fetchTradingFee=async()=>{fees++;assert.fail('a public-only refresh cannot acquire private fees');};
    adapter.fetchExecutionSnapshots=async(_bases,context)=>{
      if(context)contexts.push(context);
      const count=(counts.get(adapter.id)??0)+1;counts.set(adapter.id,count);
      const quote=structuredClone(f.quotes.get(adapter.id)!);quote.bookTransport='websocket';
      await hook(adapter.id,count,quote);Object.assign(quote,{timestamp:Date.now(),observedAt:Date.now()});return [quote];
    };
  }
  const refresh=()=>f.engine.execution.context.refreshReductionSnapshots!(f.p.base,['gate','bitget']);
  const quote=(exchange:ExchangeId)=>f.engine.snapshots.find(row=>row.exchange===exchange&&row.base===f.p.base)!;
  const unchanged=()=>{assert.deepEqual(f.store.data.orders,original);assert.deepEqual(f.p,cash);assert.equal(fees,0);};
  const slow=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));f.advance(2501);};
  return {...f,counts,cache,contexts,refresh,quote,unchanged,slow,onRead:(value:typeof hook)=>{hook=value;}};
}

test('joined selected WS books refresh only the early leg that aged while its sibling completed',async t=>{
  const f=selected(t);f.onRead(async(exchange,count)=>{if(exchange==='bitget'&&count===1)await f.slow();});
  await f.refresh();assert.equal(f.counts.get('gate'),2);assert.equal(f.counts.get('bitget'),1);
  assert.ok(['gate','bitget'].every(exchange=>quoteIsFresh(f.quote(exchange as ExchangeId),f.engine.config)));
  assert.equal(f.quote('gate').fundingObservedAt,NOW);assert.equal(f.quote('gate').takerFeeAt,NOW);f.unchanged();
});

test('joined selected books adopt an exact fresh cache before requesting the early venue again',async t=>{
  const f=selected(t);f.onRead(async(exchange,count)=>{
    if(exchange==='bitget'&&count===1){await f.slow();f.cache.set('gate',{...structuredClone(f.quotes.get('gate')!),bookTransport:'websocket',
      timestamp:Date.now(),observedAt:Date.now(),bids:[{price:1.015,quantity:1000}]});}
  });
  await f.refresh();assert.equal(f.counts.get('gate'),1);assert.equal(f.counts.get('bitget'),1);
  assert.equal(f.quote('gate').observedAt,Date.now());assert.equal(f.quote('gate').bids[0].price,1.015);
  assert.equal(f.quote('gate').fundingObservedAt,NOW);f.unchanged();
});

test('joined recovery enforces the original second-read limit when the other recovery ages the first again',async t=>{
  const f=selected(t);f.onRead(async(exchange,count)=>{
    if(exchange==='bitget'&&count===1){await f.slow();}
    if(exchange==='gate'&&count===2){await f.slow();}
  });
  await assert.rejects(f.refresh(),SelectedPublicBookError);
  assert.equal(f.counts.get('gate'),2);assert.equal(f.counts.get('bitget'),1);f.unchanged();
});

test('selected REST book retains its original configured freshness instead of adopting the WS two second limit',async t=>{
  const f=selected(t);f.onRead(async(exchange,count,quote)=>{quote.bookTransport='rest';if(exchange==='bitget'&&count===1)await f.slow();});
  await f.refresh();assert.equal(f.counts.get('gate'),1);assert.equal(f.counts.get('bitget'),1);
  assert.equal(f.quote('gate').observedAt,NOW);assert.ok(quoteIsFresh(f.quote('gate'),f.engine.config));f.unchanged();
});

for(const rule of ['symbol','contractSize','quantityStep','minQuantity','minNotional'] as const)
test(`selected recovery refuses a changed ${rule} and never acquires another contract fee`,async t=>{
  const f=selected(t);f.onRead(async(exchange,count,quote)=>{
    if(exchange==='bitget'&&count===1)await f.slow();
    if(exchange==='gate'&&count===2){if(rule==='symbol')quote.symbol='OTHER/USDT:USDT';else quote[rule]+=1;}
  });
  await assert.rejects(f.refresh());assert.equal(f.counts.get('gate'),2);assert.equal(f.counts.get('bitget'),1);f.unchanged();
});

test('selected recovery retains expired funding metadata and cannot refresh it by reading a new book',async t=>{
  const f=selected(t);f.onRead(async(exchange,count)=>{if(exchange==='bitget'&&count===1){await new Promise<void>(resolve=>setImmediate(resolve));f.advance(30001);}});
  await assert.rejects(f.refresh(),SelectedPublicBookError);f.unchanged();
});

test('an early public refusal keeps ownership until the selected sibling preparation settles',async t=>{
  const f=selected(t),gate=f.adapters.find(adapter=>adapter.id==='gate')!,bitget=f.adapters.find(adapter=>adapter.id==='bitget')!;
  let release!:()=>void,entered!:()=>void,finished=false;
  const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  gate.fetchExecutionSnapshots=async()=>[];const original=bitget.fetchExecutionSnapshots!.bind(bitget);
  bitget.fetchExecutionSnapshots=async(bases,context)=>{entered();await pending;return original(bases,context);};
  const refresh=f.refresh().then(()=>{finished=true;},error=>{finished=true;throw error;});
  t.after(async()=>{release();await refresh.catch(()=>{});});await started;
  for(let i=0;i<12;i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(finished,false);release();await assert.rejects(refresh,SelectedPublicBookError);f.unchanged();
});

test('each selected public GET receives the existing bounded read context',async t=>{
  const f=selected(t);await f.refresh();assert.equal(f.contexts.length,2);
  assert.ok(f.contexts.every(context=>context.deadlineAt===NOW+8000));f.unchanged();
});

test('one delayed required fee makes both original books share the joined one-recovery budget',async t=>{
  const f=selected(t),fees:ExchangeId[]=[];
  for(const adapter of f.adapters)adapter.fetchTradingFee=async()=>{
    fees.push(adapter.id);if(adapter.id==='bitget')await f.slow();
    return {takerFeeRate:.0005,takerFeeAt:NOW,takerFeeSource:'exchange'};
  };
  await f.engine.execution.context.refreshSnapshots!(f.p.base,['gate','bitget']);
  assert.deepEqual(fees.sort(),['bitget','gate']);assert.equal(f.counts.get('gate'),2);assert.equal(f.counts.get('bitget'),2);
  assert.equal(f.quote('gate').fundingObservedAt,NOW);assert.equal(f.quote('bitget').fundingObservedAt,NOW);f.unchanged();
});

test('an initial changed symbol refuses the selected preparation without looking up an extra contract fee',async t=>{
  const f=selected(t),fees:string[]=[];
  for(const adapter of f.adapters)adapter.fetchTradingFee=async symbol=>{fees.push(symbol);return {takerFeeRate:.0005,takerFeeAt:NOW,takerFeeSource:'exchange'};};
  f.onRead((exchange,_count,quote)=>{if(exchange==='gate')quote.symbol='OTHER/USDT:USDT';});
  await assert.rejects(f.engine.execution.context.refreshSnapshots!(f.p.base,['gate','bitget']));
  assert.equal(fees.length,2);assert.ok(fees.every(symbol=>symbol===f.p.long.symbol));f.unchanged();
});
