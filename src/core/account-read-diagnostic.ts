import type {ExchangeId} from '../shared/types.js';
import {classifyNetworkError,exchangeApiCode,type NetworkCode} from '../adapters/network.js';

/** A local single-flight guard, never evidence of a native account API refusal. */
export class AccountReadPending extends Error {
  constructor(readonly exchange:ExchangeId){super('该交易所上次只读请求尚未结束，保留结果未知并等待重试');this.name='AccountReadPending';}
}

const codes=new Set<NetworkCode>(['REGION_BLOCKED','ACCESS_DENIED','PROXY_UNAVAILABLE','RATE_LIMITED','TIMEOUT','DNS_ERROR','TLS_ERROR','NETWORK_ERROR','API_ERROR']);
const reasons:Record<NetworkCode,string>={
  REGION_BLOCKED:'账户只读请求受到地区限制',ACCESS_DENIED:'账户只读访问被拒绝',
  PROXY_UNAVAILABLE:'账户只读连接的本机代理不可用',RATE_LIMITED:'账户只读请求受到频率限制',
  TIMEOUT:'账户只读请求超时',DNS_ERROR:'账户只读地址解析失败',TLS_ERROR:'账户只读安全连接未通过',
  NETWORK_ERROR:'账户只读连接中断',API_ERROR:'账户只读响应或数据核验未通过',
};
/** Classify this private read's own failure. No public health, raw messages or credentials are retained. */
export function accountReadDiagnostic(exchange:ExchangeId,error:unknown,usingProxy=false):string {
  try{
    if(error instanceof AccountReadPending)return error.exchange===exchange?
      '账户上次只读请求仍在途，等待原读取结束（READ_IN_PROGRESS）':'账户只读读取失败，原始原因未确认';
    const code=classifyNetworkError(error,usingProxy);
    if(!codes.has(code))return '账户只读读取失败，原始原因未确认';
    const apiCode=exchangeApiCode(exchange,error);
    return `${reasons[code]}（${code}${apiCode?` / ${apiCode}`:''}）`;
  }catch{return '账户只读读取失败，原始原因未确认';}
}
