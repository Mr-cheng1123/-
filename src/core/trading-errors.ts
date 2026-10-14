import type { ExchangeId } from '../shared/types.js';
import { bitgetAccountReadError } from '../adapters/bitget-account.js';
import { gateReadError } from '../adapters/gate-private.js';
import { bybitReadError } from '../adapters/bybit-private.js';
import { exchangeApiCode, ExchangeNetworkError, type GateApiLabel, type NetworkCode } from '../adapters/network.js';

export type TradingStage='账户检查'|'合约检查'|'杠杆准备';
const names:Record<ExchangeId,string>={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};
// Official REST code references (messages below are fixed application wording):
// https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code
// https://bybit-exchange.github.io/docs/v5/error
// https://www.okx.com/docs-v5/en/#error-codes
const venueMessages:Partial<Record<ExchangeId,Record<string,string>>>={
  binance:{
    '-1002':'当前操作未获授权，请检查该接口所需权限',
    '-1003':'交易所请求频率超限，请稍后重新检查',
    '-1007':'交易所处理超时，操作结果尚未确认；请先核对状态',
    '-1021':'请求时间不在交易所允许窗口内，请检查本机时钟',
    '-1022':'签名校验未通过，请检查本机凭据配置',
    '-1111':'数量或价格精度不符合该合约要求',
    '-1121':'交易所未识别该合约，请检查合约状态',
    '-2014':'API Key 格式未通过校验，请在本机检查凭据',
    '-2015':'API Key、IP 白名单或当前操作权限未通过检查',
    '-2019':'合约可用保证金不足',
    '-4028':'请求杠杆未通过校验，请核对允许范围和当前设置',
    '-4046':'保证金模式未发生变化，仍须读回确认当前模式',
    '-4047':'该合约存在挂单，不能变更保证金模式',
    '-4048':'该合约存在仓位，不能变更保证金模式',
    '-4061':'订单 positionSide 与账户持仓模式不一致',
    '-4164':'订单名义金额未达到该合约最低要求',
  },
  bybit:{
    '429':'交易服务负载过高，请稍后重新检查',
    '10000':'交易所处理超时，操作结果尚未确认；请先核对状态',
    '10001':'交易所拒绝请求参数，请核对合约、保证金模式和 positionIdx',
    '10002':'请求时间不在交易所允许窗口内，请检查本机时钟',
    '10003':'API Key 无效或与正式／测试环境不匹配',
    '10004':'签名校验未通过，请检查本机凭据配置',
    '10005':'当前操作权限不足，请检查 API Key 的对应权限',
    '10006':'交易所请求频率超限，请稍后重新检查',
    '10010':'请求出口不在 API Key 的 IP 白名单中',
    '10028':'当前接口要求统一账户，请核对账户类型',
    '100028':'当前接口不支持统一账户，请核对接口与账户类型',
    '110007':'合约可用余额不足',
    '110013':'当前风险限额不允许设置此杠杆',
    '110024':'该合约已有仓位，不能切换持仓模式',
    '110028':'该合约已有挂单，不能切换持仓模式',
    '110029':'该合约不支持双向持仓模式',
    '110036':'当前全仓模式不允许此次杠杆调整',
    '110038':'当前组合保证金模式不允许此次杠杆调整',
    '110043':'杠杆未发生变化，仍须读回确认是否达到目标',
  },
  okx:{
    '1':'交易所报告本次请求失败，请核对单项业务错误码',
    '2':'交易所报告部分请求失败，请逐项核对实际结果',
    '50011':'交易所请求频率超限，请稍后重新检查',
    '50102':'请求时间已过期，请检查本机时钟',
    '50105':'Passphrase 校验未通过，请在本机检查完整凭据',
    '50110':'请求出口不在 API Key 的 IP 白名单中',
    '50111':'API Key 校验未通过，请在本机检查凭据',
    '50113':'签名校验未通过，请检查本机凭据配置',
    '51000':'交易所拒绝请求参数，请核对合约、tdMode 和 posSide',
    '51008':'可用余额或保证金不足',
    '51010':'当前账户模式不支持此接口，请核对账户类型',
  },
};
const gateMessages:Record<GateApiLabel,string>={
  NO_CHANGE:'交易所报告参数未变化，仍须完成设置读回核验',
  READ_ONLY:'当前 API Key 仅有读取权限，不能执行此操作；请检查合约写入权限',
  FORBIDDEN:'当前账户或 API Key 无权执行此操作，请检查对应接口权限',
  IP_FORBIDDEN:'当前请求出口不在 API Key 的 IP 白名单中',
  INVALID_CREDENTIALS:'交易所未接受当前 API 凭据，请在本机重新检查凭据配置',
  INVALID_KEY:'交易所未接受当前 API Key，请在本机检查该 Key 状态',
  INVALID_SIGNATURE:'请求签名校验失败，请检查本机 API 凭据和系统时间',
  REQUEST_EXPIRED:'请求时间已过期，请检查本机系统时间',
  ACCOUNT_LOCKED:'交易所账户已锁定，当前操作不可执行',
  LEVERAGE_TOO_LOW:'请求杠杆低于交易所允许范围，请检查合约杠杆设置',
  LEVERAGE_TOO_HIGH:'请求杠杆高于交易所允许范围，请检查合约杠杆设置',
  POSITION_EMPTY:'交易所报告目标仓位为空，请重新核对仓位和当前操作',
  INVALID_PARAM_VALUE:'交易所拒绝当前参数值，请检查合约、持仓模式和杠杆参数',
  INVALID_REQUEST_BODY:'交易所拒绝请求格式，请检查当前接口适配',
  INVALID_ARGUMENT:'交易所拒绝当前参数，请检查合约和接口参数',
  MISSING_REQUIRED_PARAM:'交易所报告缺少必填参数，请检查当前接口适配',
  CONTRACT_NOT_FOUND:'交易所未找到该合约，请重新核对合约状态',
  USER_NOT_FOUND:'交易所未找到对应合约账户，请检查账户开通状态',
  INSUFFICIENT_AVAILABLE:'合约可用保证金不足，请重新检查账户余额',
  POSITION_CROSS_MARGIN:'当前全仓仓位不允许此保证金操作，请核对合约模式',
  POSITION_DUAL_MODE:'交易所拒绝当前双向持仓模式下的此项操作，请核对接口参数',
  ORDER_PENDING:'该合约存在挂单，交易所不允许当前操作',
  POSITION_HOLDING:'该合约存在持仓，交易所不允许当前操作',
  POSITION_NOT_FOUND:'交易所未找到目标仓位，请重新核对持仓',
};
const networkMessages:Record<NetworkCode,string>={
  REGION_BLOCKED:'交易所拒绝当前网络出口所在地区，请检查可用线路',
  ACCESS_DENIED:'交易所拒绝访问，请检查网络出口和当前操作权限',
  PROXY_UNAVAILABLE:'本机代理不可用，请检查代理程序或端口',
  RATE_LIMITED:'交易所限流，请稍后重新检查',
  TIMEOUT:'请求超时，当前操作结果尚未确认；请核对后再继续',
  DNS_ERROR:'交易所域名解析失败，请检查网络或代理',
  TLS_ERROR:'安全连接失败，请检查网络线路',
  NETWORK_ERROR:'网络连接中断，当前操作结果尚未确认；请核对后再继续',
  API_ERROR:'交易所未提供可安全识别的错误原因，请重新检查当前操作',
};
const fallback='未能确认执行条件，请检查账户权限、合约设置和接口状态';
const unknownBusiness='交易所未通过当前操作，已保留业务错误码供核对';

function localReason(exchange:ExchangeId,error:unknown):string|undefined{
  if(!(error instanceof Error))return undefined;
  const message=Object.getOwnPropertyDescriptor(error,'message')?.value;
  if(typeof message!=='string')return undefined;
  const common:Record<string,string>={
    '交易所只读请求超时，本轮已跳过；迟到结果不会更新账户或资金费':'本次只读核验超时，已跳过本轮；迟到结果不用于更新账户或资金费，等待新的只读核验',
    '该交易所上次只读请求尚未结束，保留结果未知并等待重试':'此前只读核验尚未结束，结果仍未知；等待原请求结束后重新核验，未重复发起该读取',
    'Private trading API is disabled in paper/demo mode':'当前模式未启用私有交易接口',
    'Leverage exceeds configured maximum':'请求杠杆无效或超出当前配置上限',
    [`${exchange}: API credentials are missing from environment`]:'本机尚未配置完整 API 凭据',
    [`${exchange}: USDT balance unavailable`]:'未取得有效 USDT 可用余额和账户权益，不能确认开仓额度',
    [`${exchange}: unknown position side`]:'交易所持仓方向无法识别，请先核对实际持仓',
    [`${exchange}: incomplete position risk data`]:exchange==='gate'||exchange==='bitget'?'持仓价格、杠杆或强平价格数据不完整':'持仓标记价格或杠杆数据不完整，无法核对现有仓位',
    [`${exchange}: invalid position quantity data`]:'持仓数量字段无效，无法确认现有仓位是否为空',
    [`${exchange}: configure one-way/net position mode first`]:'当前适配要求单向／净持仓模式，读取结果未确认该条件',
    [`${exchange}: configure isolated margin before live entry`]:'未能确认逐仓模式；此执行路径要求逐仓（isolated），当前保证金模式不会被自动切换',
    [`${exchange}: unable to verify requested leverage`]:'杠杆读回结果与请求值不一致，尚未确认设置生效',
    [`${exchange}: prepareTrading must succeed before opening orders`]:'合约与杠杆准备尚未通过，不能发送开仓订单',
    'Order quantity does not match exchange lot size':'订单币数量不符合交易所合约张数精度',
    'Order is below minimum quantity/notional':'订单数量或名义金额低于交易所最低要求',
    'Order is below minimum quantity/notional or exceeds maximum':'订单数量或名义金额不符合交易所上下限，本次未发送订单',
    'Order unit rules unavailable or conflicting':'合约数量步长或上下限规则缺失／矛盾，无法核验委托参数',
    'Order precision conversion failed':'订单数量或价格无法按交易所精度转换，本次未发送订单',
    'Order price exceeds configured limit':'交易所价格精度无法满足原委托限价，本次未发送订单',
    'Invalid order base/quantity/limit':'订单币种、数量或限价无效',
    'Maker reduction requires an exact PostOnly reduce-only request':'Maker 减仓必须使用有效限价、数量及 PostOnly／只减仓参数',
    'Maker reduction venue unsupported':'该交易所尚未支持已核验的 Maker 减仓接口',
    'Exact Maker reduction slot unsupported':'该交易所不支持当前精确分仓 Maker 减仓选择',
    'Unsupported Maker entry selector':'Maker 委托参数与当前交易所或开平仓路径不匹配',
    'Unsupported exact close selector':'该交易所或当前委托不支持此精确分仓平仓选择',
  };
  if(Object.hasOwn(common,message))return common[message];
  // Dynamic contract names are discarded; only the exact locally generated sentence shape is accepted.
  const escaped=exchange.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(new RegExp(`^${escaped}: external/existing position on [A-Z0-9][A-Z0-9._-]{0,39}/USDT:USDT; entry refused$`).test(message))return '该合约已有持仓，不能将现有仓位混入新的套利组合';
  if(new RegExp(`^${escaped}: external/pending order on [A-Z0-9][A-Z0-9._-]{0,39}/USDT:USDT; entry refused$`).test(message))return '该合约已有挂单，不能准备新的套利开仓';
  if(new RegExp(`^${escaped}: only active linear USDT perpetuals are supported: [A-Z0-9][A-Z0-9._-]{0,39}/USDT:USDT$`).test(message))return '合约必须是正常交易的 USDT 线性永续，请核对合约状态';
  const local:Partial<Record<ExchangeId,Record<string,string>>>={
    binance:{
      'binance: symbol configuration unavailable':'未取得该合约的完整账户配置，不能核验保证金模式和杠杆',
      'binance: unknown margin mode':'未识别该合约保证金模式；当前执行路径要求已确认的逐仓模式',
      'binance: invalid symbol leverage':'该合约当前杠杆字段无效，不能核验执行设置',
      'binance: unable to verify requested margin mode':'该合约保证金模式读回与所选全仓／逐仓不一致，不能继续开仓',
      'binance: external/pending conditional order; margin change refused':'该合约已有条件挂单，不能修改保证金模式',
    },
    bybit:{'bybit: one-way positionIdx=0 must be verified':'未能确认单向持仓 positionIdx=0；当前路径不能使用未核验的持仓索引',
      'bybit: configure crossed account margin before live entry':'所选全仓与 Bybit 账户模式不一致，请先在交易所调整账户保证金模式；软件不会自动切换整个账户',
      'bybit: configure isolated account margin before live entry':'所选逐仓与 Bybit 账户模式不一致，请先在交易所调整账户保证金模式；软件不会自动切换整个账户',
      'bybit: invalid position quantity':'交易所持仓数量无效，不能确认可减仓范围',
      'bybit: a positive reduce-only quantity is required':'Bybit 减仓必须使用有效正数数量及只减仓参数',
      'bybit: reduction preflight requires reduce-only':'Bybit 减仓预检要求只减仓参数，本次未发送订单'},
    okx:{'okx: isolated leverage scope unavailable':'未确认逐仓杠杆设置范围；当前路径要求 isolated 保证金和 net 净持仓',
      'okx: cross leverage scope unavailable':'未确认该合约全仓杠杆及 net 净持仓范围，不能继续开仓',
      'okx: native position margin scope unavailable for reduction':'未取得待平仓位的实际保证金模式，请刷新持仓后重试',
      'okx: ambiguous native position margin scope; reduction refused':'待平仓位包含不同保证金模式或方向未确认，不能使用单一模式平仓'},
    bitget:{
      'bitget: account type lookup failed':'账户类型查询未成功，不能选择 Classic 或 UTA 执行接口',
      'bitget: classic single-asset USDT futures account required; UTA and multi-assets are unsupported':'Classic 执行路径要求单币 USDT 合约账户；统一账户应使用 UTA 路径',
      'bitget: configure one-way position mode before trading':'Classic 执行路径要求单向持仓，当前读取结果未满足条件',
      'bitget: configure isolated margin before trading':'Classic 执行路径要求逐仓保证金，当前读取结果未满足条件',
      'bitget: classic margin mode must be verified':'Classic 合约保证金模式未确认，不能核验执行参数',
      'bitget: position must use single-direction isolated USDT margin':'Classic 现有仓位必须采用单向、逐仓、USDT 保证金',
      'bitget: USDT futures balance unavailable':'未能唯一确认 USDT 合约账户余额',
      'bitget: incomplete USDT futures balance':'USDT 合约余额或权益字段不完整',
      'bitget: existing position/order check unavailable':'现有持仓或挂单数据不完整，不能确认可准备新开仓',
      'bitget: existing position or pending order; entry refused':'该合约已有仓位或挂单，不能准备新开仓',
      'bitget: existing UTA position or pending order; entry refused':'UTA 合约已有仓位、挂单或未核实数量，不能准备新开仓',
      'bitget: unable to verify requested leverage on both sides':'Classic 多空两侧杠杆未全部通过读回确认',
      'bitget: UTA leverage or unchanged margin mode could not be verified':'UTA 杠杆读回未达到目标，或账户／持仓／保证金模式发生变化',
      'bitget: UTA isolated account has incompatible symbol margin mode':'UTA 账户为逐仓，但合约保证金模式不匹配；不会自动切换账户模式',
      'bitget: UTA symbol margin/leverage configuration unavailable':'UTA 未返回完整合约保证金和杠杆配置',
      'bitget: UTA position mode or currency mismatch':'UTA 仓位方向、保证金模式或保证金币种与账户设置不一致',
      'bitget: incomplete UTA balances':'UTA 可用 USDT、保证金或权益数据不完整，无法确认开仓额度',
      'bitget: incomplete UTA position risk data':'UTA 持仓价格、杠杆或强平价格数据不完整',
      'bitget: invalid UTA leverage':'UTA 请求杠杆无效，必须是大于等于 1 的有限数值',
      'bitget: invalid UTA list response':'UTA 列表响应格式未通过校验，无法确认账户状态',
      'bitget: classic margin mode change could not be verified':'Classic 合约保证金模式未通过读回确认，不能继续设置杠杆或开仓',
      'bitget: existing trigger order check unavailable':'该合约条件挂单数据未确认，不能修改保证金模式',
      'bitget: active strategy order check unavailable':'UTA 策略挂单数据未确认，不能修改合约保证金模式',
    },
    gate:{
      'gate: invalid private list response':'合约账户列表响应格式未通过校验',
      'gate: position holding mode mismatch':'持仓方向与账户持仓模式不一致',
      'gate: invalid position quantity':'交易所持仓数量无效，不能确认可减仓范围',
      'gate: invalid exact close position selector':'Gate 精确平仓选择的方向、保证金模式或仓位身份无效',
      'gate: a positive reduce-only quantity is required':'Gate 减仓必须使用有效正数张数及只减仓参数',
      'gate: split position margin mode is unverified':'分仓保证金模式未确认，无法使用该仓位',
      'gate: position margin mode is unverified':'持仓保证金模式或杠杆字段未确认',
      'gate: incomplete position risk data':'持仓价格、杠杆或强平价格数据不完整',
      'gate: invalid requested leverage':'请求杠杆无效，必须是大于等于 1 的有限数值',
      'gate: requested cross margin could not be verified':'该合约所选全仓模式未通过读回确认，不能继续开仓',
      'gate: requested isolated margin could not be verified':'该合约所选逐仓模式未通过读回确认，不能继续开仓',
    },
  };
  const known=local[exchange];return known&&Object.hasOwn(known,message)?known[message]:undefined;
}

/** A display-safe execution error. No cause, original message or private response is retained. */
export class TradingError extends Error {
  readonly code?:NetworkCode;
  readonly apiCode?:string;
  constructor(readonly exchange:ExchangeId,readonly stage:TradingStage,error:unknown){
    const code=error instanceof ExchangeNetworkError?error.code:undefined;
    const candidate=exchangeApiCode(exchange,error);
    let apiCode:string|undefined,reason:string|undefined;
    if(exchange==='gate'&&candidate&&Object.hasOwn(gateMessages,candidate)){
      apiCode=candidate;reason=gateMessages[candidate as GateApiLabel];
    }else if(exchange==='bitget'&&candidate){
      apiCode=candidate;
      if(candidate==='40014')reason=stage==='杠杆准备'?'当前杠杆准备操作权限不足，请检查对应账户管理/杠杆写入权限；无需提现权限':
        '当前读取操作权限不足，请检查对应账户或合约的读取权限；无需提现权限';
      else if(candidate==='25200')reason='交易所参数校验未通过，请检查当前操作的合约、模式和杠杆参数';
      else reason=unknownBusiness;
    }else if(candidate){
      apiCode=candidate;
      const messages=venueMessages[exchange];reason=messages&&Object.hasOwn(messages,candidate)?messages[candidate]:unknownBusiness;
    }
    if(!reason){
      try{
        const localMessage=error instanceof Error?Object.getOwnPropertyDescriptor(error,'message')?.value:undefined;
        const plain=typeof localMessage==='string'?new Error(localMessage):undefined;
        const known=localReason(exchange,error)??(plain?(exchange==='gate'?gateReadError(plain):exchange==='bybit'?bybitReadError(plain):exchange==='bitget'&&!candidate?bitgetAccountReadError(plain):undefined):undefined);
        if(typeof known==='string')reason=known;
      }catch{/* malformed third-party error properties must not escape the fixed fallback */}
    }
    super(`${names[exchange]} ${stage}未通过：${reason??(code?networkMessages[code]:fallback)}${apiCode?`（${apiCode}）`:''}`);
    this.name='TradingError';this.code=code;this.apiCode=apiCode;
  }
}

export function tradingError(exchange:ExchangeId,stage:TradingStage,error:unknown):TradingError{
  return new TradingError(exchange,stage,error);
}
