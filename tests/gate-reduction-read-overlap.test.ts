import test from 'node:test';
import assert from 'node:assert/strict';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import type {OrderRequest} from '../src/shared/types.js';

const symbol='ONE/USDT:USDT',market={id:'ONE_USDT',symbol,base:'ONE',quote:'USDT',settle:'USDT',swap:true,linear:true,
  active:true,contractSize:10};
const account={currency:'USDT',available:'400',total:'500',unrealised_pnl:'0',position_mode:'dual_plus',margin_mode:0};
const held=(changes:Record<string,unknown>={})=>({contract:market.id,size:'20',mode:'dual_long',pos_margin_mode:'isolated',
  pid:'922337203685477581',lever:'2',leverage:'2',mark_price:'.002024',liq_price:'.001057',entry_price:'.002085',
  unrealised_pnl:'0',pnl_fund:'0',pnl_fee:'0',pnl_pnl:'0',open_time:'1790927498',update_time:'1790934900',...changes});
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
async function flush(){for(let n=0;n<12;n++)await Promise.resolve();}
function fixture(){
  const modeRead=deferred<typeof account>(),positionRead=deferred<Record<string,unknown>[]>(),calls:string[]=[],posted:any[]=[];
  const client:any={markets:{[symbol]:market},market:()=>market,amountToPrecision:(_symbol:string,value:number)=>String(value),
    priceToPrecision:(_symbol:string,value:number)=>String(value),
    privateFuturesGetSettleAccounts:()=>{calls.push('account');return modeRead.promise;},
    privateFuturesGetSettlePositions:()=>{calls.push('positions');return positionRead.promise;},
    privateFuturesPostSettleOrders:async(payload:any)=>{calls.push('create');posted.push(payload);return {id:'1001'};}};
  return {client,calls,posted,modeRead,positionRead,gate:new GatePrivate(client)};
}
function request(postOnly=false,exact=true):OrderRequest{
  return {base:'ONE',symbol,side:'sell',quantity:100,limitPrice:.002,clientOrderId:'offline-gate-overlap',reduceOnly:true,
    ...(postOnly?{postOnly:true}:{}),...(exact?{closePosition:{side:'long',marginMode:'isolated',
      positionId:'922337203685477581',positionOpenedAt:1790927498000}}:{})};
}
function place(f:ReturnType<typeof fixture>,req:OrderRequest,canSubmit?:()=>boolean){
  return req.postOnly?f.gate.placeMakerReduction(req,10,.002,canSubmit):f.gate.place(req,10,.002);
}

test('Gate IOC and Maker reductions start both native GETs together and create only after both settle',async()=>{
  for(const postOnly of [false,true])for(const first of ['account','positions'] as const){
    const f=fixture(),task=place(f,request(postOnly));
    assert.deepEqual(f.calls,['account','positions'],'the holding GET must not wait for account RTT');
    if(first==='account')f.modeRead.resolve(account);else f.positionRead.resolve([held()]);
    await flush();assert.equal(f.posted.length,0,'one successful GET cannot authorize a create');
    if(first==='account')f.positionRead.resolve([held()]);else f.modeRead.resolve(account);
    assert.equal(await task,'1001');assert.equal(f.posted.length,1);
    assert.deepEqual([f.posted[0].size,f.posted[0].reduce_only,f.posted[0].tif,f.posted[0].pos_margin_mode,f.posted[0].pid],
      ['-10',true,postOnly?'poc':'ioc','isolated','922337203685477581']);
  }
});

test('either failed Gate reduction GET drains its pending sibling and retains the original refusal classification',async()=>{
  for(const postOnly of [false,true])for(const exact of [false,true])for(const failed of ['account','positions'] as const){
    const f=fixture();let finished=false;
    const outcome=place(f,request(postOnly,exact)).then(()=>{finished=true;return undefined;},error=>{finished=true;return error;});
    assert.deepEqual(f.calls,['account','positions']);
    (failed==='account'?f.modeRead:f.positionRead).reject(new Error(`offline ${failed} failure`));
    await flush();assert.equal(finished,false,'a rejected GET must wait for its sibling to finish');assert.equal(f.posted.length,0);
    if(failed==='account')f.positionRead.resolve([held()]);else f.modeRead.resolve(account);
    const error=await outcome;assert.ok(error instanceof Error);assert.equal(f.posted.length,0);
    if(failed==='positions'||exact){
      assert.ok(error instanceof OrderNotSubmittedError);
      assert.equal(error.rejectionCode,failed==='account'?'CLOSE_POSITION_UNVERIFIED':'CLOSE_POSITION_CHANGED');
    }else assert.match(error.message,/offline account failure/);
  }
});

test('both failed Gate reduction GETs are observed before return and the account failure keeps precedence',async()=>{
  const f=fixture();let finished=false;
  const outcome=place(f,request(true)).catch(error=>{finished=true;return error;});
  f.modeRead.reject(new Error('offline account failure'));await flush();assert.equal(finished,false);
  f.positionRead.reject(new Error('offline positions failure'));
  const error=await outcome;assert.ok(error instanceof OrderNotSubmittedError);
  assert.equal(error.rejectionCode,'CLOSE_POSITION_UNVERIFIED');assert.equal(f.posted.length,0);
});

test('parallel Gate reads still reject changed PID, margin, cycle, held quantity, mode and ambiguous targets',async()=>{
  const changes=[{pid:'922337203685477582'},{pos_margin_mode:'cross'},{open_time:'1790933775'},{size:'9'},
    {mode:'dual_short',size:'-20'}];
  for(const postOnly of [false,true])for(const change of changes){
    const f=fixture(),task=place(f,request(postOnly));
    f.positionRead.resolve([held(change)]);await flush();assert.equal(f.posted.length,0);
    f.modeRead.resolve(account);
    await assert.rejects(task,(error:unknown)=>error instanceof OrderNotSubmittedError&&error.rejectionCode==='CLOSE_POSITION_CHANGED');
    assert.equal(f.posted.length,0);
  }
  const f=fixture(),task=place(f,request(false,false));
  f.modeRead.resolve(account);f.positionRead.resolve([held(),held({pid:'922337203685477582'})]);
  await assert.rejects(task,OrderNotSubmittedError);assert.equal(f.posted.length,0);
});

test('a Maker permission change during parallel native reads vetoes create at the original final guard',async()=>{
  const f=fixture();let allowed=true;const task=place(f,request(true),()=>allowed);
  f.positionRead.resolve([held()]);await flush();allowed=false;f.modeRead.resolve(account);
  await assert.rejects(task,(error:unknown)=>error instanceof OrderNotSubmittedError&&error.rejectionCode==='MAKER_REDUCTION_PERMISSION_CHANGED');
  assert.equal(f.posted.length,0);
});

test('Gate entry checks do not start a holding GET through the reduction optimization',async()=>{
  const f=fixture(),req={...request(false,false),side:'buy' as const,reduceOnly:false},task=place(f,req);
  assert.deepEqual(f.calls,['account']);f.modeRead.resolve(account);
  await assert.rejects(task,/opening order requires verified preparation/);
  assert.deepEqual(f.calls,['account']);assert.equal(f.posted.length,0);
});
