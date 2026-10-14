import type { AppConfig, ExchangeAdapter } from '../shared/types.js';
import { CcxtAdapter } from './ccxt.js';
import { DemoAdapter } from './demo.js';
export { CcxtAdapter, DemoAdapter };
export function createAdapters(config:AppConfig):ExchangeAdapter[] {
  const epoch = Date.now();
  return config.exchanges.map(id=>config.dataSource==='demo' ? new DemoAdapter(id,config,epoch) : new CcxtAdapter(id,config));
}
/** Background public scanner: no credentials, private preparation, optional OI or history warming. */
export function createPublicMonitoringAdapters(config:AppConfig):ExchangeAdapter[] {
  return config.exchanges.map(id=>new CcxtAdapter(id,{...config,mode:'paper',autoEnabled:false},undefined,true));
}
