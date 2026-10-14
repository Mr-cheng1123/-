import {BitgetClassic} from './bitget-classic.js';
import {BitgetUta} from './bitget-uta.js';
import {assertExchangeRequestActive} from './network.js';

export const BITGET_VERIFIED_CACHE_MS=2000;
interface VerifiedSettings {data:any;requestedAt:number}
interface ClientProofs {
  identity:unknown[];epoch:number;modeEpoch:number;
  settings?:VerifiedSettings;settingsPending?:{request:Promise<VerifiedSettings>;epoch:number};
  modes:Map<string,{value:any;requestedAt:number;epoch:number;modeEpoch:number}>;
}
const proofs=new WeakMap<object,ClientProofs>();
function state(client:any):ClientProofs{
  if(!client||!['object','function'].includes(typeof client))throw new Error('bitget: invalid private client');
  const identity=[client.apiKey,client.secret,client.password,client.privateUtaGetV3AccountSettings,
    client.privateUtaGetV3AccountAssets,client.privateMixGetV2MixAccountAccount];
  let current=proofs.get(client);
  if(!current){current={identity,epoch:0,modeEpoch:0,modes:new Map()};proofs.set(client,current);}
  else if(identity.some((value,index)=>value!==current!.identity[index])){
    current.identity=identity;current.epoch++;current.modeEpoch++;current.settings=undefined;current.modes.clear();
  }
  return current;
}
function currentAt(requestedAt:number){const now=Date.now();return Number.isFinite(requestedAt)&&requestedAt>0&&requestedAt<=now&&now-requestedAt<BITGET_VERIFIED_CACHE_MS;}
/** Close, credentials, failed reads and setting writes must not retain a previous execution proof. */
export function clearBitgetAccountCache(client:any):void{
  const current=state(client);current.epoch++;current.modeEpoch++;current.settings=undefined;current.modes.clear();
}
/** A new balance observation invalidates mode/asset-health evidence, without caching that balance. */
export function invalidateBitgetTradingModes(client:any):void{const current=state(client);current.modeEpoch++;current.modes.clear();}
export function bitgetTradingModeVersion(client:any){const current=state(client);return {epoch:current.epoch,modeEpoch:current.modeEpoch};}
/** Internal GET proof cache. WS account/order observers cannot create these entries. */
export function cachedBitgetTradingMode<T>(client:any,key:string):T|undefined{
  const current=state(client),proof=current.modes.get(key);
  if(!proof||proof.epoch!==current.epoch||proof.modeEpoch!==current.modeEpoch||!currentAt(proof.requestedAt)){current.modes.delete(key);return;}
  return structuredClone(proof.value);
}
export function rememberBitgetTradingMode(client:any,key:string,value:any,requestedAt:number,version:{epoch:number;modeEpoch:number}):void{
  const current=state(client);
  if(version.epoch!==current.epoch||version.modeEpoch!==current.modeEpoch||!currentAt(requestedAt))return;
  if(current.modes.size>=256&&!current.modes.has(key))current.modes.delete(current.modes.keys().next().value!);
  current.modes.set(key,{value:structuredClone(value),requestedAt,...version});
}
/** Native v3 settings GET, shared across short-lived account wrappers; TTL starts before transport. */
export async function readVerifiedBitgetSettings(client:any,force=false):Promise<VerifiedSettings>{
  const current=state(client);
  if(!force&&current.settings&&currentAt(current.settings.requestedAt))return {data:structuredClone(current.settings.data),requestedAt:current.settings.requestedAt};
  if(current.settingsPending){
    const pending=current.settingsPending;
    if(pending.epoch===current.epoch)return pending.request.then(read=>({data:structuredClone(read.data),requestedAt:read.requestedAt}));
    // An unrelated failed read or reconfiguration invalidates proofs, not an
    // outstanding native GET. Drain it before acquiring a new identity/mode
    // proof; its late value or rejection cannot authorize this new caller.
    await pending.request.then(()=>undefined,()=>undefined);
    assertExchangeRequestActive(client,'bitget');
    return readVerifiedBitgetSettings(client,force);
  }
  invalidateBitgetTradingModes(client);
  const epoch=current.epoch,requestedAt=Date.now();
  const pending=(async()=>{
    try{
      const response=await client.privateUtaGetV3AccountSettings({});
      if(response?.code==='40014')throw Object.assign(new Error('Bitget UTA management read permission required'),{apiCode:'40014'});
      if(response?.code!=='00000'||!['unified','hybrid'].includes(response?.data?.accountMode)){
        if(response?.code!=='00000')throw new Error('bitget: account type lookup failed');
        throw new Error('bitget: account mode is unknown or transitioning; retry once the upgrade is complete');
      }
      const read={data:structuredClone(response.data),requestedAt};
      if(current.epoch===epoch&&currentAt(requestedAt))current.settings=read;
      return read;
    }catch(error){clearBitgetAccountCache(client);throw error;}
  })();
  current.settingsPending={request:pending,epoch};
  try{const read=await pending;return {data:structuredClone(read.data),requestedAt:read.requestedAt};}
  finally{if(current.settingsPending?.request===pending)current.settingsPending=undefined;}
}
/** Read-only account routing hint for a private stream; expired/failed/never-read remains unknown. */
export function cachedBitgetAccountMode(client:any):'classic'|'unified'|undefined{
  const current=state(client),read=current.settings;
  if(!read||!currentAt(read.requestedAt))return;
  return read.data.accountMode==='unified'?'unified':read.data.accountMode==='hybrid'?'classic':undefined;
}

/** A failed UTA settings read must never silently select the old empty Classic balance. */
export async function bitgetAccount(client:any,newSymbolMarginMode:'crossed'|'isolated'='isolated',desiredMarginMode?:'crossed'|'isolated'):Promise<BitgetClassic|BitgetUta>{
  const cached=cachedBitgetAccountMode(client);
  if(cached==='unified')return new BitgetUta(client,newSymbolMarginMode,desiredMarginMode);
  if(cached==='classic')return new BitgetClassic(client,5000,newSymbolMarginMode,desiredMarginMode);
  const {data}=await readVerifiedBitgetSettings(client),mode=data.accountMode;
  if(mode==='unified')return new BitgetUta(client,newSymbolMarginMode,desiredMarginMode);
  if(mode==='hybrid')return new BitgetClassic(client,5000,newSymbolMarginMode,desiredMarginMode);
  throw new Error('bitget: account mode is unknown or transitioning; retry once the upgrade is complete');
}

export function bitgetAccountReadError(error:unknown):string|undefined{
  if(error&&typeof error==='object'&&'apiCode' in error&&error.apiCode==='40014')
    return 'Bitget API 权限不足（40014）：请为当前 Key 开启 UTA／统一账户管理的读取权限后重新检查；无需提现权限';
  // Fixed local adapter errors only; never echo a private API response or credentials.
  const known:Record<string,string>={
    'bitget: UTA isolated account cannot initialize crossed symbol':'Bitget 当前为逐仓 UTA 账户，不能用全仓初始化新合约；请将新合约保证金选择为逐仓',
    'bitget: invalid UTA new symbol margin preference':'Bitget 新合约保证金配置无效，请重新选择全仓或逐仓',
    'bitget: UTA leverage preview margin unavailable':'Bitget 杠杆预检未返回有效保证金数据，已停止准备和下单',
    'bitget: UTA holding mode must be verified':'Bitget 连接已通过；尚未确认账户是单向还是双向持仓，无法确定开平仓参数',
    'bitget: UTA borrowed or unverified assets are unsupported for execution':'Bitget 连接已通过；统一账户存在负债或负债数据不完整，当前执行适配不支持此账户状态',
    'bitget: UTA negative or unverified asset equity is unsupported for execution':'Bitget 连接已通过；统一账户存在负权益或资产权益数据不完整，请检查账户资产',
    'bitget: UTA advanced/delta/unknown collateral modes are read-only':'Bitget 连接已通过；当前账户模式暂只支持余额查询，执行仅支持基础或逐仓 UTA',
    'bitget: UTA symbol margin/leverage must be explicitly configured':'Bitget 连接已通过；尚未取得该合约的保证金模式和杠杆设置，无法确认订单参数',
    'bitget: UTA symbol margin/leverage configuration unavailable':'Bitget 合约设置读取不完整，无法判断该合约是否已有设置；请重试账户读取',
    'bitget: account mode is unknown or transitioning; retry once the upgrade is complete':'Bitget 账户类型尚未确认或正在升级，请待账户升级完成后重新检查',
  };
  if(error instanceof Error&&Object.hasOwn(known,error.message))return known[error.message];
  return undefined;
}
