import {Worker} from 'node:worker_threads';
import type {AppConfig,BacktestResult,HistoricalRow} from '../shared/types.js';

type BacktestWorker=Pick<Worker,'once'|'terminate'>;
interface BacktestTaskOptions {
  timeoutMs?:number;
  createWorker?:()=>BacktestWorker;
}

/** Every worker exit settles the HTTP task, including a clean exit without a result. */
export function runBacktestTask(rows:HistoricalRow[],config:AppConfig,source:string,options:BacktestTaskOptions={}):Promise<BacktestResult> {
  return new Promise((resolve,reject)=>{
    const worker=options.createWorker?.()??new Worker(new URL('./backtest-worker.mjs',import.meta.url),{workerData:{rows,config,source}});
    const requested=options.timeoutMs??60_000;
    const timeout=Number.isFinite(requested)&&requested>0?Math.min(requested,60_000):60_000;
    let settled=false;
    const stop=()=>{try{void worker.terminate().catch(()=>{});}catch{/* The task is already settled. */}};
    const finish=(error:Error|undefined,result?:BacktestResult)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(error)reject(error);else resolve(result!);
      stop();
    };
    const timer=setTimeout(()=>finish(new Error('回测超过 60 秒，请缩短数据区间')),timeout);
    worker.once('message',message=>{
      if(!message||typeof message!=='object')return finish(new Error('回测进程未返回有效结果'));
      if(typeof message.error==='string')return finish(new Error(message.error));
      if(!message.result||typeof message.result!=='object')return finish(new Error('回测进程未返回有效结果'));
      finish(undefined,message.result as BacktestResult);
    });
    worker.once('error',error=>finish(error));
    worker.once('exit',code=>finish(new Error(code===0?'回测进程未返回结果就退出，请重试':'回测进程异常退出')));
  });
}
