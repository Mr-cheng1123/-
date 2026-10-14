import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {runBacktestTask} from '../src/core/backtest-task.js';
import {defaultConfig} from '../src/shared/config.js';

class MemoryWorker extends EventEmitter {
  terminations=0;
  async terminate(){this.terminations++;return 0;}
}
const offline=(worker:MemoryWorker,timeoutMs=100)=>runBacktestTask([],defaultConfig,'OFFLINE',{timeoutMs,createWorker:()=>worker as unknown as Worker});

test('a clean worker exit without a result rejects instead of leaving the backtest busy forever',async()=>{
  const worker=new MemoryWorker(),pending=offline(worker);
  worker.emit('exit',0);
  await assert.rejects(pending,/未返回结果就退出/);assert.equal(worker.terminations,1);
});
test('timeout and abnormal exits settle once and release their worker',async()=>{
  const stalled=new MemoryWorker();await assert.rejects(offline(stalled,5),/回测超过/);
  assert.equal(stalled.terminations,1);
  stalled.emit('message',{result:{trades:999}});stalled.emit('exit',0);
  assert.equal(stalled.terminations,1);
  const crashed=new MemoryWorker(),pending=offline(crashed);crashed.emit('exit',1);
  await assert.rejects(pending,/异常退出/);assert.equal(crashed.terminations,1);
});
test('malformed worker replies fail and a valid result wins over its later termination exit',async()=>{
  const bad=new MemoryWorker(),rejected=offline(bad);bad.emit('message',{});
  await assert.rejects(rejected,/有效结果/);
  const worker=new MemoryWorker(),pending=offline(worker),result={trades:3};
  worker.emit('message',{result});worker.emit('exit',1);
  assert.deepEqual(await pending,result);assert.equal(worker.terminations,1);
});
test('native backtest worker returns a result and surfaces an unsupported policy without network access',async()=>{
  const config={...defaultConfig,dualAdvantageEnabled:false,holdMode:'once' as const};
  const result=await runBacktestTask([],config,'OFFLINE');assert.equal(result.trades,0);
  await assert.rejects(runBacktestTask([],{...config,holdMode:'adaptive'},'OFFLINE'),/自主判断持仓暂不支持/);
});
