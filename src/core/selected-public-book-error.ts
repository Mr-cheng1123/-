import type {ExchangeId} from '../shared/types.js';

export type SelectedPublicBookFailure='missing'|'not-fresh'|'read-failed';
const venues:Record<ExchangeId,string>={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'},
  reasons:Record<SelectedPublicBookFailure,string>={missing:'未返回所选币种数据','not-fresh':'所选币种数据未通过时效核验','read-failed':'读取失败，原始原因未确认'};
const localEvidence=new WeakMap<object,{exchange:ExchangeId;reason:SelectedPublicBookFailure}>();
const wording=(exchange:ExchangeId,reason:SelectedPublicBookFailure)=>`${venues[exchange]} 公开执行${reason==='read-failed'?'行情':'盘口'}${reasons[reason]}`;
/** Fixed facts from the selected public read boundary or its unchanged response guard. */
export class SelectedPublicBookError extends Error {
  constructor(readonly exchange:ExchangeId,readonly reason:SelectedPublicBookFailure){
    if(!Object.hasOwn(venues,exchange)||!Object.hasOwn(reasons,reason))throw new Error('公开盘口诊断参数无效');
    super(wording(exchange,reason));this.name='SelectedPublicBookError';
    localEvidence.set(this,{exchange,reason});
  }
}
/** The fixed local facts, never an arbitrary message, getter or serialized name, select the wording. */
export function selectedPublicBookReason(error:unknown):string|undefined {
  if(!(error instanceof SelectedPublicBookError))return;
  const evidence=localEvidence.get(error);return evidence&&wording(evidence.exchange,evidence.reason);
}
