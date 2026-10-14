import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';
import { CcxtAdapter } from '../adapters/ccxt.js';
import { EXCHANGES, type AccountState, type AccountOverview, type AppConfig, type ExchangeId } from '../shared/types.js';
import { inspectLiveEnvironment } from './live-readiness.js';
import { bitgetAccountReadError } from '../adapters/bitget-account.js';
import { gateReadError } from '../adapters/gate-private.js';
import { bybitReadError } from '../adapters/bybit-private.js';
import { exchangeApiCode, ExchangeNetworkError } from '../adapters/network.js';
import { tradingError } from './trading-errors.js';

export interface AccountConnection {
  exchange:ExchangeId; credentialsConfigured:boolean;
  status:'not_configured'|'unchecked'|'checking'|'connected'|'error';
  message?:string;checkedAt?:number;freeUsd?:number;equityUsd?:number;positionCount?:number;
  balanceScope?:'usdt_futures'|'unified_usdt';isolatedAvailableUsd?:number;spotAvailableUsd?:number;
  accountType?:'classic'|'unified';accountMode?:string;positionMode?:string;executionSupported?:boolean;
  usdtAvailableUsd?:number;marginAvailableUsd?:number;
  spotStatus?:'available'|'unavailable';warnings?:string[];
}
type ReadOnlyAccountClient={fetchAccount:()=>Promise<AccountState|AccountOverview>;close:()=>Promise<void>};
interface Options {
  env?:Record<string,string|undefined>;
  timeoutMs?:number;
  createClient?:(id:ExchangeId,config:AppConfig)=>ReadOnlyAccountClient;
}
const credential=z.string().min(1).max(2048).refine(value=>value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value),'凭据不可包含首尾空白或控制字符');
export const credentialsSchema=z.object({apiKey:credential,apiSecret:credential,passphrase:credential.optional()}).strict();
export type Credentials=z.infer<typeof credentialsSchema>;

function quoteEnv(key:string,value:string):string {
  // Confirm exact dotenv round-trip instead of relying on shell or JSON escaping.
  for(const encoded of [JSON.stringify(value),`'${value}'`,`\`${value}\``]){
    const line=`${key}=${encoded}`;
    if(dotenv.parse(line)[key]===value)return line;
  }
  throw new Error('凭据包含本机配置无法安全保存的字符');
}

export function saveLocalCredentials(envPath:string,id:ExchangeId,input:unknown,env:Record<string,string|undefined>=process.env):void {
  if(!(EXCHANGES as readonly string[]).includes(id))throw new Error('交易所不支持');
  const value=credentialsSchema.parse(input);
  if((id==='okx'||id==='bitget')&&!value.passphrase)throw new Error('该交易所需要 Passphrase');
  const prefix=id.toUpperCase(),updates:Record<string,string>={
    [`${prefix}_API_KEY`]:value.apiKey,[`${prefix}_API_SECRET`]:value.apiSecret,
    ...((id==='okx'||id==='bitget')?{[`${prefix}_PASSPHRASE`]:value.passphrase!}:{}),
  };
  const original=existsSync(envPath)?readFileSync(envPath,'utf8'):'';
  const keys=new Set(Object.keys(updates));
  const retained=original.split(/\r?\n/).filter(line=>{
    const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match||!keys.has(match[1]);
  }).join('\n').trimEnd();
  const next=`${retained}${retained?'\n':''}${Object.entries(updates).map(([key,value])=>quoteEnv(key,value)).join('\n')}\n`;
  const temp=`${envPath}.${randomUUID()}.tmp`;
  let descriptor:number|undefined;
  try{
    descriptor=openSync(temp,'wx',0o600);writeFileSync(descriptor,next);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
    renameSync(temp,envPath);
  }catch{
    if(descriptor!==undefined)try{closeSync(descriptor);}catch{}
    try{unlinkSync(temp);}catch{}
    throw new Error('本机凭据保存失败，请检查配置文件权限');
  }
  for(const [key,value] of Object.entries(updates))env[key]=value;
}

function connectionError(error:unknown,exchange:ExchangeId):string {
  const known=bitgetAccountReadError(error)??gateReadError(error)??bybitReadError(error);if(known)return known;
  if(error instanceof ExchangeNetworkError||exchangeApiCode(exchange,error))return tradingError(exchange,'账户检查',error).message;
  const name=error instanceof Error?error.name:'';
  if(['AuthenticationError','PermissionDenied','AccountSuspended'].includes(name))return '鉴权或权限检查失败，请核对密钥、Passphrase、IP 限制及读取权限';
  if(['RequestTimeout','NetworkError','ExchangeNotAvailable'].includes(name))return '账户接口暂不可达，请检查网络或稍后重试';
  return '账户读取失败，请检查密钥、账户类型、合约权限及连接配置';
}

/** Local setup only. This class cannot place orders, cancel orders, or change leverage. */
export class AccountConnections {
  private readonly env:Record<string,string|undefined>;
  private states=new Map<ExchangeId,AccountConnection>();
  private inFlight=new Map<ExchangeId,{token:object;response:Promise<AccountConnection>}>();
  constructor(private readonly envPath:string,private readonly config:()=>AppConfig,private readonly options:Options={}){
    this.env=options.env??process.env;
  }
  list():AccountConnection[]{
    return inspectLiveEnvironment(this.env).exchanges.map(({exchange,credentialsConfigured})=>{
      const saved=this.states.get(exchange);
      const scope=exchange==='bitget'?{balanceScope:saved?.balanceScope??'usdt_futures' as const,
        ...(saved?.accountType?{accountType:saved.accountType}:{}),...(saved?.accountMode?{accountMode:saved.accountMode}:{}),
        ...(saved?.positionMode?{positionMode:saved.positionMode}:{}),...(saved?.executionSupported!==undefined?{executionSupported:saved.executionSupported}:{})}:{};
      if(!credentialsConfigured)return {...scope,exchange,credentialsConfigured:false,status:'not_configured',message:'尚未配置完整交易凭据'};
      if(saved?.status==='connected'&&Date.now()-(saved.checkedAt??0)>60000)return {...scope,exchange,credentialsConfigured:true,status:'unchecked',checkedAt:saved.checkedAt,message:'上次账户检查已超过 60 秒，请重新检查；旧余额不作为当前余额'};
      return {...scope,...(saved??{exchange,status:'unchecked' as const,message:'凭据已配置，尚未检查连接'}),credentialsConfigured:true};
    });
  }
  assertCanSave(id:ExchangeId):void {
    if(this.inFlight.has(id))throw new Error('该交易所正在检查连接，请等待请求结束后再修改凭据');
  }
  save(id:ExchangeId,input:unknown):AccountConnection {
    this.assertCanSave(id);
    saveLocalCredentials(this.envPath,id,input,this.env);
    const state:AccountConnection={exchange:id,credentialsConfigured:true,status:'unchecked',message:'已保存至本机；请检查连接。保存不会开启实盘交易'};
    this.states.set(id,state);return {...state};
  }
  check(id:ExchangeId):Promise<AccountConnection>{
    const existing=this.inFlight.get(id);if(existing)return existing.response;
    const current=this.list().find(x=>x.exchange===id);
    if(!current?.credentialsConfigured)return Promise.resolve(current??{exchange:id,credentialsConfigured:false,status:'not_configured'});
    const token={},response=Promise.resolve().then(()=>this.runCheck(id,token));
    this.inFlight.set(id,{token,response});return response;
  }
  private async runCheck(id:ExchangeId,token:object):Promise<AccountConnection>{
    const previous=this.states.get(id);
    const metadata:Partial<AccountConnection>=previous?{
      balanceScope:previous.balanceScope,accountType:previous.accountType,accountMode:previous.accountMode,
      positionMode:previous.positionMode,executionSupported:previous.executionSupported,
    }:{};
    this.states.set(id,{...metadata,exchange:id,credentialsConfigured:true,status:'checking',message:'只读检查余额与持仓中'});
    const timeoutMs=this.options.timeoutMs??15000;
    let client:ReadOnlyAccountClient|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false;
    const closeClient=()=>{if(client&&!closed){closed=true;void client.close().catch(()=>{});}};
    let timedOut=false;
    try{
      client=(this.options.createClient??((id,config)=>{
        const adapter=new CcxtAdapter(id,config);
        return {fetchAccount:()=>adapter.fetchAccountOverview(),close:()=>adapter.close()};
      }))(id,{...this.config(),mode:'live',dataSource:'public',autoEnabled:false});
      const raw=Promise.resolve().then(()=>client!.fetchAccount());
      void raw.finally(()=>{
        if(this.inFlight.get(id)?.token===token)this.inFlight.delete(id);
        closeClient();
      }).catch(()=>{});
      const account=await Promise.race([raw,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{timedOut=true;reject(new Error('Read-only check timed out'));},timeoutMs);
      })]);
      const positionCount='positionCount' in account?account.positionCount:Array.isArray(account.positions)?account.positions.length:NaN;
      if(!Number.isFinite(account.freeUsd)||!Number.isFinite(account.equityUsd)||!Number.isSafeInteger(positionCount)||positionCount<0)throw new Error('Invalid account response');
      const overview='positionCount' in account?account:undefined;
      const state:AccountConnection={exchange:id,credentialsConfigured:true,status:'connected',checkedAt:Date.now(),
        freeUsd:account.freeUsd,equityUsd:account.equityUsd,positionCount,
        ...(overview?.balanceScope?{balanceScope:overview.balanceScope}:{}),
        ...(overview?.accountType?{accountType:overview.accountType}:{}),
        ...(overview?.accountMode?{accountMode:overview.accountMode}:{}),
        ...(overview?.positionMode?{positionMode:overview.positionMode}:{}),
        ...(overview?.executionSupported!==undefined?{executionSupported:overview.executionSupported}:{}),
        ...(Number.isFinite(overview?.usdtAvailableUsd)?{usdtAvailableUsd:overview!.usdtAvailableUsd}:{}),
        ...(Number.isFinite(overview?.marginAvailableUsd)?{marginAvailableUsd:overview!.marginAvailableUsd}:{}),
        ...(Number.isFinite(overview?.isolatedAvailableUsd)?{isolatedAvailableUsd:overview!.isolatedAvailableUsd}:{}),
        ...(Number.isFinite(overview?.spotAvailableUsd)?{spotAvailableUsd:overview!.spotAvailableUsd}:{}),
        ...(overview?.spotStatus?{spotStatus:overview.spotStatus}:{}),
        ...(overview?.warnings?.length?{warnings:overview.warnings}:{}),
        message:'余额与持仓读取成功；下单权限、持仓设置及真实成交尚未验证'};
      this.states.set(id,state);return {...state};
    }catch(error){
      const state:AccountConnection={...metadata,exchange:id,credentialsConfigured:true,status:'error',checkedAt:Date.now(),
        message:timedOut?'连接检查超时；交易状态未改变，请稍后重试':connectionError(error,id)};
      this.states.set(id,state);
      if(!client&&this.inFlight.get(id)?.token===token)this.inFlight.delete(id);
      return {...state};
    }finally{
      if(timer)clearTimeout(timer);
      if(timedOut)closeClient();
    }
  }
}
