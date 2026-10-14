import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import ccxt from 'ccxt';
import {GatePrivate} from '../src/adapters/gate-private.js';
import type {OrderRequest} from '../src/shared/types.js';

const KEY='gate-offline-regression-key',SECRET='gate-offline-regression-secret';
type Mode='single'|'dual'|'dual_plus';
/** Real installed CCXT serialization and signing; every transport call ends in a local fixture. */
function fixture(base:string,maximum:number,mode:Mode='dual_plus',initialMargin='cross',postOnly=false){
  const symbol=`${base}/USDT:USDT`,contract=`${base}_USDT`,calls:{method:string;path:string;query:Record<string,string>;body:any}[]=[];
  const client:any=new ccxt.gate({apiKey:KEY,secret:SECRET,enableRateLimit:false,options:{defaultType:'swap',defaultSettle:'USDT',unifiedAccount:false,maxRetriesOnFailure:0}});
  client.setMarkets([{id:contract,symbol,base,quote:'USDT',settle:'USDT',baseId:base,quoteId:'USDT',settleId:'USDT',type:'swap',spot:false,
    margin:false,swap:true,future:false,option:false,contract:true,active:true,linear:true,inverse:false,contractSize:base==='TRUST'?10:.1,
    precision:{amount:1,price:.00001},limits:{leverage:{min:1,max:maximum},amount:{min:1},cost:{min:1}},info:{leverage_min:'1',leverage_max:String(maximum)}}]);
  let margin=initialMargin,leverage='10',staleShort=false;
  const position=(side:string)=>({contract,size:'0',mode:side,pos_margin_mode:margin,lever:side==='dual_short'&&staleShort?'10':leverage,
    leverage:margin==='cross'?'0':leverage,cross_leverage_limit:leverage});
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),method=String(params.method),headers=new Headers(params.headers),rawBody=params.body as string|undefined;
    assert.equal(url.hostname,'api.gateio.ws');assert.equal(headers.get('KEY'),KEY);
    const auth=[method,url.pathname,decodeURIComponent(url.search.slice(1)),createHash('sha512').update(rawBody??'').digest('hex'),headers.get('Timestamp')].join('\n');
    assert.equal(headers.get('SIGN'),createHmac('sha512',SECRET).update(auth).digest('hex'));
    const query=Object.fromEntries(url.searchParams),body=rawBody?JSON.parse(rawBody):undefined;calls.push({method,path:url.pathname,query,body});
    let data:any;
    if(method==='GET'){
      assert.equal(rawBody,undefined);
      if(url.pathname.endsWith('/accounts'))data={currency:'USDT',available:'500',total:'500',unrealised_pnl:'0',position_mode:mode,margin_mode:0};
      else if(url.pathname.endsWith('/positions')||url.pathname.endsWith('/orders')||url.pathname.endsWith('/price_orders'))data=[];
      else if(url.pathname.endsWith(`/get_leverage/${contract}`)){
        assert.equal(mode,'dual_plus');assert.equal(query.pos_margin_mode,'cross');assert.ok(['dual_long','dual_short'].includes(query.dual_side));
        data={Lever:query.dual_side==='dual_short'&&staleShort?'10':leverage};
      }else if(url.pathname.endsWith(`/dual_comp/positions/${contract}`))data=['dual_long','dual_short'].map(position);
      else if(url.pathname.endsWith(`/positions/${contract}`))data=position('single');
      else throw new Error('Unexpected GET fixture route');
    }else if(url.pathname.endsWith('/cross_mode')){
      assert.equal(method,'POST');assert.deepEqual(query,{});assert.deepEqual(body,{contract,mode:'CROSS'});
      assert.equal(url.pathname,`/api/v4/futures/usdt/${mode==='single'?'positions':'dual_comp/positions'}/cross_mode`);
      margin='cross';data=mode==='single'?position('single'):['dual_long','dual_short'].map(position);
    }else if(url.pathname.endsWith(`/positions/${contract}/set_leverage`)){
      assert.equal(method,'POST');assert.equal(rawBody,undefined);
      // In the reported regression, Gate rejected dual_side with margin_mode=cross.
      assert.deepEqual(query,{leverage:'2',margin_mode:'cross'});leverage=query.leverage;data={lever:leverage};
    }else if(url.pathname.endsWith('/orders')){
      assert.equal(method,'POST');assert.deepEqual(query,{});assert.equal(body.contract,contract);assert.equal(body.tif,postOnly?'poc':'ioc');
      assert.equal(body.pos_margin_mode,mode==='dual_plus'?'cross':undefined);assert.equal(body.dual_side,undefined);data={id:'73001'};
    }else throw new Error('Unexpected write fixture route');
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  return {client,calls,symbol,adapter:new GatePrivate(client),stale:()=>{staleShort=true;}};
}

for(const [base,maximum] of [['TRUST',10],['KSTR',20]] as const){
  test(`Gate ${base} default 10x to 2x signs one shared cross leverage write without dual_side and confirms both reads`,async()=>{
    const f=fixture(base,maximum),sign=f.client.sign;
    await f.adapter.inspectTrading(f.symbol,2);assert.ok(f.calls.every(c=>c.method==='GET'));
    await f.adapter.prepare(f.symbol,2);assert.equal(f.client.sign,sign);
    const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.ok(writes[0].path.endsWith('/set_leverage'));
    const readback=f.calls.slice(f.calls.indexOf(writes[0])+1).filter(c=>c.path.includes('/get_leverage/'));
    assert.deepEqual(readback.map(c=>c.query.dual_side).sort(),['dual_long','dual_short']);
    await f.adapter.prepare(f.symbol,2);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
    const request:OrderRequest={clientOrderId:`offline-${base}`,symbol:f.symbol,base,side:'sell',quantity:f.client.market(f.symbol).contractSize*10,limitPrice:1,reduceOnly:false};
    assert.equal(await f.adapter.place(request,10,1),'73001');
  });
  test(`Gate ${base} contract leverage bounds reject unsupported requests before any private write`,async()=>{
    const f=fixture(base,maximum);
    await assert.rejects(f.adapter.inspectTrading(f.symbol,maximum+1),/outside contract limits/);
    await assert.rejects(f.adapter.prepare(f.symbol,maximum+1),/outside contract limits/);
    assert.equal(f.calls.length,0);
  });
}

for(const mode of ['single','dual'] as const){
  test(`Gate ${mode} margin-mode switch uses signed JSON body, empty query, one shared leverage write and fresh cross readback`,async()=>{
    const f=fixture('TRUST',10,mode,'isolated'),sign=f.client.sign;
    await f.adapter.prepare(f.symbol,2);assert.equal(f.client.sign,sign);
    assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.path),[
      `/api/v4/futures/usdt/${mode==='single'?'positions':'dual_comp/positions'}/cross_mode`,
      '/api/v4/futures/usdt/positions/TRUST_USDT/set_leverage',
    ]);
    const request:OrderRequest={clientOrderId:`offline-${mode}`,symbol:f.symbol,base:'TRUST',side:'buy',quantity:100,limitPrice:1,reduceOnly:false};
    assert.equal(await f.adapter.place(request,10,1),'73001');
  });
}

test('Gate shared cross write never permits entry when either independently read side still has the old leverage',async()=>{
  const f=fixture('TRUST',10);f.stale();
  await assert.rejects(f.adapter.prepare(f.symbol,2),/could not be verified/);
  const request:OrderRequest={clientOrderId:'offline-stale',symbol:f.symbol,base:'TRUST',side:'buy',quantity:100,limitPrice:1,reduceOnly:false};
  await assert.rejects(f.adapter.place(request,10,1),/requires verified preparation/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('Gate Maker first leg signs native poc and rejects reduce-only Maker before creating an order',async()=>{
  const f=fixture('TRUST',10,'dual_plus','cross',true);await f.adapter.prepare(f.symbol,2);
  const request:OrderRequest={clientOrderId:'offline-gate-maker',symbol:f.symbol,base:'TRUST',side:'sell',quantity:100,limitPrice:1,reduceOnly:false,postOnly:true};
  assert.equal(await f.adapter.place(request,10,1),'73001');
  assert.equal(f.calls.filter(c=>c.path.endsWith('/orders')&&c.method==='POST').length,1);
  await assert.rejects(f.adapter.place({...request,clientOrderId:'offline-gate-maker-close',reduceOnly:true},10,1),/Maker trial/);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/orders')&&c.method==='POST').length,1);
});
