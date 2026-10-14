import type {ExchangeId} from './types.js';

function own(value:unknown,key:string):unknown {
  return value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
}
/** Retain only a bounded native business message. Never keep the complete error, URL, headers or body. */
export function sanitizeApiMessage(value:unknown,privateValues:readonly string[]=[]):string|undefined {
  if(typeof value!=='string'||value.length>65536)return;
  let message=value;
  for(const secret of privateValues)if(typeof secret==='string'&&secret.length>=4)message=message.split(secret).join('[redacted]');
  message=message.replace(/https?:\/\/\S+/gi,'[redacted-url]')
    .replace(/["']?\b(?:authorization|x-bapi-sign|x-bapi-api-key|api[_-]?key|api[_-]?secret|access[_-]?token|secret|password|passphrase|signature|token)\b["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g,'[redacted]')
    .replace(/\b\d{8,}\b/g,'[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return message?message.slice(0,240):undefined;
}
/** Venue-bound native retMsg extraction, without executing getters or parsing unrelated private payloads. */
export function safeExchangeApiMessage(exchange:ExchangeId,error:unknown,privateValues:readonly string[]=[]):string|undefined {
  if(exchange!=='bybit')return;
  try{
    const venue=own(error,'exchange');if(typeof venue==='string'&&venue!==exchange)return;
    const exceptionText=own(error,'message');
    if(typeof exceptionText==='string'&&/^(?:binance(?:usdm|coinm)?|okx|gate|gateio|bitget)\s+\{/i.test(exceptionText))return;
    const marked=own(error,'apiMessage');if(typeof marked==='string')return sanitizeApiMessage(marked,privateValues);
    const direct=own(error,'retMsg');
    if(typeof direct==='string'&&own(error,'retCode')!==undefined)return sanitizeApiMessage(direct,privateValues);
    if(!(error instanceof Error))return;
    const text=own(error,'message');if(typeof text!=='string'||text.length>65536||!/^bybit\s+\{/i.test(text))return;
    const payload=JSON.parse(text.slice(text.indexOf('{')));
    if(own(payload,'retCode')===undefined)return;
    return sanitizeApiMessage(own(payload,'retMsg'),privateValues);
  }catch{return;}
}
