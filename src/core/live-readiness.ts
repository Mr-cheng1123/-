import { EXCHANGES, type ExchangeId, type LiveExchangeReadiness } from '../shared/types.js';

export interface LiveEnvironment {
  permissionGranted:boolean;
  exchanges:LiveExchangeReadiness[];
}

/** Inspect credential presence without retaining or exposing credential values. */
export function inspectLiveEnvironment(env:Readonly<Record<string,string|undefined>>=process.env):LiveEnvironment {
  const present=(key:string)=>Boolean(env[key]?.trim());
  return {
    permissionGranted:env.ALLOW_LIVE_TRADING==='true'&&env.LIVE_TRADING_ACK==='I_UNDERSTAND_THE_RISKS',
    exchanges:EXCHANGES.map(exchange=>({
      exchange,supported:true,
      credentialsConfigured:present(`${exchange.toUpperCase()}_API_KEY`)&&present(`${exchange.toUpperCase()}_API_SECRET`)&&
        (exchange!=='okx'||present('OKX_PASSPHRASE'))&&(exchange!=='bitget'||present('BITGET_PASSPHRASE')),
    })),
  };
}

export function liveEligibleExchanges(environment:LiveEnvironment,enabled:readonly ExchangeId[]):LiveExchangeReadiness[] {
  return environment.exchanges.filter(x=>enabled.includes(x.exchange)&&x.supported&&x.credentialsConfigured);
}
