import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import type {ExchangeId,TradingFeeReference} from '../shared/types.js';

export const LOCAL_ACCOUNT_FEE_MAX_ENTRIES=512;
const MAX_FILE_BYTES=512_000;
const EXCHANGES=new Set<ExchangeId>(['binance','bybit','gate','bitget','okx']);
interface Entry {exchange:ExchangeId;identity:string;symbol:string;reference:TradingFeeReference}
const key=(exchange:ExchangeId,identity:string,symbol:string)=>JSON.stringify([exchange,identity,symbol]);
const validScope=(exchange:ExchangeId,identity:string,symbol:string)=>EXCHANGES.has(exchange)&&/^[a-f0-9]{64}$/.test(identity)&&
  typeof symbol==='string'&&symbol.length<=160&&/^[^\s\x00-\x1f]+\/USDT:USDT$/.test(symbol);
function reference(value:unknown,now:number):TradingFeeReference|undefined {
  if(!value||typeof value!=='object')return;
  const row=value as Partial<TradingFeeReference>;
  if(row.source!=='account-reference'||!Number.isFinite(row.takerRate)||row.takerRate!<0||row.takerRate!>.01||
    !Number.isFinite(row.observedAt)||row.observedAt!<=0||row.observedAt!>now||
    row.makerRate!==undefined&&(!Number.isFinite(row.makerRate)||Math.abs(row.makerRate)>.01))return;
  return {source:'account-reference',takerRate:row.takerRate!,observedAt:row.observedAt!,
    ...(row.makerRate===undefined?{}:{makerRate:row.makerRate})};
}

/** Only the one-way credential digest is saved. References never establish native execution evidence. */
export function accountFeeIdentity(client:{apiKey?:unknown;secret?:unknown;password?:unknown}):string|undefined {
  if(typeof client.apiKey!=='string'||!client.apiKey||typeof client.secret!=='string'||!client.secret)return;
  return createHash('sha256').update(JSON.stringify([client.apiKey,client.secret,typeof client.password==='string'?client.password:''])).digest('hex');
}

/** Small, best-effort local references. An omitted path creates an isolated memory-only store. */
export class LocalAccountFeeCache {
  private entries=new Map<string,Entry>();
  constructor(private readonly path?:string,private readonly now:()=>number=Date.now){this.read();}
  private read():void {
    if(!this.path)return;
    try{
      if(statSync(this.path).size>MAX_FILE_BYTES)return;
      const saved=JSON.parse(readFileSync(this.path,'utf8'));
      if(saved?.version!==1||!Array.isArray(saved.entries))return;
      for(const row of saved.entries){
        if(!row||!validScope(row.exchange,row.identity,row.symbol))continue;
        const value=reference(row.reference,this.now());if(!value)continue;
        this.remember(row.exchange,row.identity,row.symbol,value,false);
      }
    }catch{/* Missing or invalid display references never block account reads or trading. */}
  }
  cached(exchange:ExchangeId,identity:string|undefined,symbol:string):TradingFeeReference|undefined {
    if(!identity||!validScope(exchange,identity,symbol))return;
    const value=this.entries.get(key(exchange,identity,symbol))?.reference;
    return value?reference(value,this.now()):undefined;
  }
  remember(exchange:ExchangeId,identity:string|undefined,symbol:string,value:TradingFeeReference,persist=true):void {
    if(!identity||!validScope(exchange,identity,symbol))return;
    const verified=reference(value,this.now());if(!verified)return;
    const entryKey=key(exchange,identity,symbol),prior=this.entries.get(entryKey);
    if(prior&&prior.reference.observedAt>verified.observedAt)return;
    this.entries.set(entryKey,{exchange,identity,symbol,reference:verified});
    if(this.entries.size>LOCAL_ACCOUNT_FEE_MAX_ENTRIES){
      const oldest=[...this.entries].sort((a,b)=>a[1].reference.observedAt-b[1].reference.observedAt)[0];
      this.entries.delete(oldest[0]);
    }
    if(persist)this.write();
  }
  private write():void {
    if(!this.path)return;
    let temporary:string|undefined;
    try{
      mkdirSync(dirname(this.path),{recursive:true});
      temporary=`${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary,JSON.stringify({version:1,entries:[...this.entries.values()]}),'utf8');
      renameSync(temporary,this.path);temporary=undefined;
    }catch{/* The in-memory observation remains usable when persistence is unavailable. */}
    finally{if(temporary)try{if(existsSync(temporary))unlinkSync(temporary);}catch{}}
  }
}

const stores=new Map<string,LocalAccountFeeCache>();
export function localAccountFeeCache(path=resolve(process.cwd(),'data/runtime/fee-reference-cache.json')):LocalAccountFeeCache {
  const fullPath=resolve(path);let store=stores.get(fullPath);
  if(!store){store=new LocalAccountFeeCache(fullPath);stores.set(fullPath,store);}return store;
}
