import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const engineUrl=new URL('../src/core/engine.ts',import.meta.url).href;
const configUrl=new URL('../src/shared/config.ts',import.meta.url).href;

/** A child process observes leaked promises without letting node:test consume their events. */
async function observe(mode:'save'|'log'|'network'){
  const script=`
    import {setImmediate as immediate} from 'node:timers/promises';
    import {Engine} from ${JSON.stringify(engineUrl)};
    import {defaultConfig} from ${JSON.stringify(configUrl)};
    const mode=${JSON.stringify(mode)};
    const config={...structuredClone(defaultConfig),mode:'paper',dataSource:'public',exchanges:['gate','bybit'],symbols:['OFFLINE']};
    let failing=false,posts=0;
    const failure=new Error('Offline persistent state write failure');
    const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
      save(){if(failing&&mode==='save')throw failure;},
      log(level,message,context){
        this.data.logs.unshift({id:'offline-'+this.data.logs.length,timestamp:Date.now(),level,message,context});
        if(failing&&mode==='log')throw failure;
        this.save();
      }};
    const adapters=config.exchanges.map(id=>({id,fetchSnapshots:async()=>[],
      fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),fetchFundingPayments:async()=>[],
      prepareTrading:async()=>{posts++;throw Error('No external preparation permitted');},
      placeOrder:async()=>{posts++;throw Error('No order permitted');},
      cancelOrder:async()=>{posts++;throw Error('No external cancellation permitted');},
      reconcileOrder:async()=>{posts++;throw Error('No external query permitted');},close:async()=>{}}));
    const engine=new Engine(store,true,{adapterFactory:()=>adapters});
    engine.autoEnabled=true;
    engine.openInternal=async()=>{throw Object.assign(new Error('Offline pre-submit account read failed'),{syscall:'connect',code:'ETIMEDOUT'});};
    let release;const barrier=new Promise(resolve=>release=resolve);
    const blocking=engine.exclusive(()=>barrier);
    const unhandled=[];
    process.on('unhandledRejection',error=>{unhandled.push({sameFailure:error===failure});});
    const id='offline-manual-persistence-001',opportunityId='OFFLINE-gate-bybit';
    const receipt=engine.requestManualEntry(opportunityId,id,Date.now()+30000);
    failing=true;release();await blocking;await engine.exclusive(async()=>{});
    for(let turn=0;turn<20;turn++)await immediate();
    const record=store.data.manualEntryOperations[0];
    const result={receiptState:receipt.state,autoEnabled:engine.autoEnabled,killSwitch:store.data.killSwitch,
      posts,unhandled,operation:{id:record.id,opportunityId:record.opportunityId,state:record.state,ordersSubmitted:record.ordersSubmitted},
      positions:store.data.positions.length,orders:store.data.orders.length};
    failing=false;await engine.stop();
    console.log(JSON.stringify(result));
  `;
  const {stdout}=await run(process.execPath,['--import','tsx','--input-type=module','-e',script],{
    cwd:new URL('..',import.meta.url),windowsHide:true,timeout:15_000,maxBuffer:64*1024,
  });
  return JSON.parse(stdout.trim()) as {
    receiptState:string;autoEnabled:boolean;killSwitch:boolean;posts:number;unhandled:unknown[];
    operation:{id:string;opportunityId:string;state:string;ordersSubmitted:boolean};positions:number;orders:number;
  };
}

function assertNoFinancialAction(result:Awaited<ReturnType<typeof observe>>){
  assert.equal(result.receiptState,'queued');
  assert.deepEqual(result.operation,{id:'offline-manual-persistence-001',opportunityId:'OFFLINE-gate-bybit',state:'failed',ordersSubmitted:false});
  assert.equal(result.posts,0);assert.equal(result.positions,0);assert.equal(result.orders,0);
}

for(const stage of ['save','log'] as const)test(`a queued manual entry ${stage} failure halts in memory and never leaks a second rejection`,async()=>{
  const result=await observe(stage);
  assertNoFinancialAction(result);
  assert.deepEqual(result.unhandled,[],'A persistent failure in diagnostic reporting must stay inside its handled boundary');
  assert.equal(result.autoEnabled,false);assert.equal(result.killSwitch,true);
});

test('an ordinary manual entry account network veto preserves automatic management without a global halt',async()=>{
  const result=await observe('network');
  assertNoFinancialAction(result);assert.deepEqual(result.unhandled,[]);
  assert.equal(result.autoEnabled,true);assert.equal(result.killSwitch,false);
});
