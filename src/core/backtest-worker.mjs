import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
try {
  const { runBacktest } = await tsImport('./backtest.ts', import.meta.url);
  parentPort.postMessage({result:runBacktest(workerData.rows,workerData.config,workerData.source)});
} catch (error) {
  parentPort.postMessage({error:error instanceof Error?error.message:'回测失败'});
}
