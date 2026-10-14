import {defaultConfig,validateConfig} from './config.js';
import type {AppConfig} from './types.js';
import {startupSpreadWarmup} from './spread-warmup-profile.js';

/** UI settings are durable; explicit environment mode/source still select the runtime. */
export function startupConfig(fromFile:Partial<AppConfig>,saved:Partial<AppConfig>,mode:AppConfig['mode'],dataSource?:string):AppConfig{
  const input={...defaultConfig,...startupSpreadWarmup({...fromFile,...saved}),mode,autoEnabled:false,
    entryPolicy:saved.entryPolicy??fromFile.entryPolicy??'aligned',
    takerFees:{...defaultConfig.takerFees,...fromFile.takerFees,...saved.takerFees},
    dataSource:mode==='live'?'public':dataSource??saved.dataSource??fromFile.dataSource??defaultConfig.dataSource};
  // Adding the new UI default must never switch a saved account's original native margin policy.
  if(saved.marginMode===undefined&&fromFile.marginMode===undefined&&(Object.keys(fromFile).length||Object.keys(saved).length))delete input.marginMode;
  // Existing scoped handovers bind the saved policy exactly; execution uses the compatible 10 bps default.
  if(saved.minExitProfitBps===undefined&&fromFile.minExitProfitBps===undefined&&(Object.keys(fromFile).length||Object.keys(saved).length))delete input.minExitProfitBps;
  return validateConfig(input);
}
