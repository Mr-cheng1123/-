import test from 'node:test';
import assert from 'node:assert/strict';
import { ExchangeNetworkError, GATE_API_LABELS } from '../src/adapters/network.js';
import { TradingError, tradingError, type TradingStage } from '../src/core/trading-errors.js';
import { OrderNotSubmittedError } from '../src/adapters/order-rejection.js';

test('Gate execution diagnostics include the actual stage and only documented business identifiers',()=>{
  for(const label of GATE_API_LABELS){
    const error=tradingError('gate','杠杆准备',new ExchangeNetworkError('API_ERROR',0,label,'gate'));
    assert(error instanceof TradingError);assert.equal(error.exchange,'gate');assert.equal(error.stage,'杠杆准备');
    assert.equal(error.code,'API_ERROR');assert.equal(error.apiCode,label);assert.match(error.message,/^Gate 杠杆准备未通过：/);
    assert(error.message.endsWith(`（${label}）`));
  }
  assert.match(tradingError('gate','杠杆准备',Object.assign(new Error('private-canary'),{apiCode:'READ_ONLY'})).message,/合约写入权限/);
  assert.match(tradingError('gate','杠杆准备',Object.assign(new Error('private-canary'),{apiCode:'LEVERAGE_TOO_HIGH'})).message,/杠杆高于/);
  assert.match(tradingError('gate','杠杆准备',Object.assign(new Error('private-canary'),{apiCode:'NO_CHANGE'})).message,/仍须完成设置读回核验/);
});

test('Bitget 40014 distinguishes read checks from leverage preparation without requesting withdrawal permission',()=>{
  for(const stage of ['账户检查','合约检查','杠杆准备'] as TradingStage[]){
    const error=tradingError('bitget',stage,new ExchangeNetworkError('API_ERROR',0,'40014','bitget'));
    assert.equal(error.apiCode,'40014');assert(error.message.startsWith(`Bitget ${stage}未通过：`));
    assert.match(error.message,/无需提现权限/);
    if(stage==='杠杆准备'){assert.match(error.message,/杠杆写入权限/);assert.doesNotMatch(error.message,/读取权限/);}
    else assert.match(error.message,/读取权限/);
  }
});

test('known local mode errors remain specific without exposing their raw payload',()=>{
  const gate=tradingError('gate','合约检查',new Error('gate: requested leverage or unchanged position mode could not be verified'));
  assert.match(gate.message,/杠杆设置未通过读回确认/);
  const bitget=tradingError('bitget','账户检查',new Error('bitget: UTA borrowed or unverified assets are unsupported for execution'));
  assert.match(bitget.message,/负债或负债数据不完整/);
  assert.doesNotMatch(gate.message+bitget.message,/could not be verified|unsupported for execution/);
  assert.equal(gate.cause,undefined);assert.equal(bitget.cause,undefined);
});

test('unknown private errors and unknown business codes use fixed text without messages, URLs, headers or raw data',()=>{
  const inputs:unknown[]=[
    Object.assign(new Error('private-canary https://user:password-canary@host.invalid?apiKey=key-canary'),{apiCode:'CUSTOM_SECRET_CANARY',raw:{headers:{KEY:'header-canary'}}}),
    {message:'private-canary',apiCode:'CUSTOM_SECRET_CANARY',headers:{KEY:'header-canary'}},
    new Error('gate {"label":"CUSTOM_SECRET_CANARY","message":"private-canary"}'),
    'https://user:password-canary@host.invalid',
    null,
  ];
  for(const input of inputs){
    for(const exchange of ['gate','bitget'] as const){
      const error=tradingError(exchange,'杠杆准备',input);
      assert.equal(error.apiCode,undefined);assert.equal(error.cause,undefined);
      assert.doesNotMatch(error.message+error.stack+JSON.stringify(error),/canary|CANARY|host\.invalid|49999|headers|raw/);
      assert.match(error.message,/未提供可安全识别|未能确认执行条件/);
    }
  }
});

test('Bitget five-digit business codes remain visible with fixed explanations and no original response',()=>{
  for(const code of ['25200','49999','00001','99999']){
    const input=new Error(`bitget {"code":"${code}","msg":"private-canary https://password-canary@host.invalid"}`);
    const error=tradingError('bitget','杠杆准备',input);
    assert.equal(error.apiCode,code);assert(error.message.endsWith(`（${code}）`));
    assert.doesNotMatch(error.message+error.stack+JSON.stringify(error),/canary|host\.invalid/);
    assert.match(error.message,code==='25200'?/参数校验未通过/:/保留业务错误码供核对/);
  }
  for(const code of ['25200secret','2520','252000','secret','２５２００']){
    const error=tradingError('bitget','杠杆准备',Object.assign(new Error('unrecognized'),{apiCode:code}));
    assert.equal(error.apiCode,undefined);assert.match(error.message,/未能确认执行条件/);
  }
});

test('network failures preserve the category and do not claim uncertain writes will automatically repeat',()=>{
  const error=tradingError('gate','杠杆准备',new ExchangeNetworkError('TIMEOUT',123,undefined,'gate'));
  assert.equal(error.code,'TIMEOUT');assert.match(error.message,/结果尚未确认/);assert.doesNotMatch(error.message,/自动重连|自动重试/);
  assert.equal(error.apiCode,undefined);
});

test('exact engine read timeout and pending-read guards keep their read-only explanation',()=>{
  const fixtures=[
    ['交易所只读请求超时，本轮已跳过；迟到结果不会更新账户或资金费',/只读核验超时.*迟到结果.*等待新的只读核验/],
    ['该交易所上次只读请求尚未结束，保留结果未知并等待重试',/只读核验尚未结束.*结果仍未知.*未重复发起该读取/],
  ] as const;
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as const)for(const [message,meaning] of fixtures){
    const error=tradingError(exchange,'账户检查',new Error(message));
    assert.match(error.message,meaning);assert.doesNotMatch(error.message,/未能确认执行条件|权限不足|自动重试/);
    assert.equal(error.code,undefined);assert.equal(error.apiCode,undefined);assert.equal(error.cause,undefined);
  }
});

test('read-guard wording only matches exact local messages and never echoes appended private data',()=>{
  const originals=[
    '交易所只读请求超时，本轮已跳过；迟到结果不会更新账户或资金费',
    '该交易所上次只读请求尚未结束，保留结果未知并等待重试',
  ];
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as const)for(const message of originals){
    for(const input of [new Error(`${message} private-canary`),new Error(`private-canary ${message}`),
      new Error(`${message}\nhttps://private-canary.invalid?apiKey=key-canary`),{message}]){
      const error=tradingError(exchange,'账户检查',input);
      assert.match(error.message,/未能确认执行条件/);
      assert.doesNotMatch(error.message+error.stack+JSON.stringify(error),/canary|只读核验超时|只读核验尚未结束/);
      assert.equal(error.cause,undefined);
    }
    const api=tradingError(exchange,'账户检查',Object.assign(new Error(message),{apiCode:exchange==='gate'?'READ_ONLY':
      exchange==='binance'?'-2015':exchange==='bybit'?'10005':exchange==='okx'?'50111':'40014'}));
    assert(api.apiCode);assert.doesNotMatch(api.message,/只读核验超时|只读核验尚未结束/);
  }
});

test('other venue and malformed error properties cannot turn into a misleading permission diagnosis',()=>{
  const mismatch=tradingError('gate','账户检查',new ExchangeNetworkError('API_ERROR',0,'40014','bitget'));
  assert.equal(mismatch.apiCode,undefined);assert.doesNotMatch(mismatch.message,/40014|UTA/);
  const malformed=Object.defineProperty(new Error('unrecognized'),'apiCode',{get(){throw new Error('private-canary');}});
  const result=tradingError('bitget','账户检查',malformed);
  assert.match(result.message,/未能确认执行条件/);assert.doesNotMatch(result.message,/private-canary/);
  assert.match(tradingError('gate','账户检查',new Error('constructor')).message,/未能确认执行条件/);
});

test('Binance, Bybit and OKX private business codes retain fixed venue-specific explanations',()=>{
  const fixtures=[
    ['binance',new Error('binanceusdm {"code":-2015,"msg":"private-canary"}'),'-2015',/白名单.*权限/],
    ['binance',new Error('binance {"code":-4061,"msg":"private-canary"}'),'-4061',/positionSide.*持仓模式/],
    ['bybit',new Error('bybit {"retCode":10005,"retMsg":"private-canary"}'),'10005',/当前操作权限不足/],
    ['bybit',new Error('bybit {"retCode":10001,"retMsg":"private-canary"}'),'10001',/positionIdx/],
    ['bybit',new Error('bybit {"retCode":110043,"retMsg":"private-canary"}'),'110043',/仍须读回确认/],
    ['okx',new Error('okx {"code":"1","data":[{"sCode":"51000","sMsg":"private-canary"}]}'),'51000',/tdMode.*posSide/],
    ['okx',new Error('okx {"code":"1","data":[{"sCode":"51008","sMsg":"private-canary"}]}'),'51008',/余额或保证金不足/],
    ['okx',new Error('okx {"code":"50113","msg":"private-canary"}'),'50113',/签名校验未通过/],
  ] as const;
  for(const [exchange,input,code,meaning] of fixtures){
    const error=tradingError(exchange,'合约检查',input);
    assert.equal(error.apiCode,code);assert.match(error.message,meaning);
    assert.doesNotMatch(error.message+error.stack+JSON.stringify(error),/private-canary|retMsg|sMsg/);assert.equal(error.cause,undefined);
  }
});

test('unknown but valid numeric business codes remain visible without inventing a cause',()=>{
  for(const [exchange,apiCode] of [['binance','-999999'],['bybit','99999999'],['okx','59999'],['bitget','49999']] as const){
    const error=tradingError(exchange,'杠杆准备',Object.assign(new Error('private-canary'),{apiCode}));
    assert.equal(error.apiCode,apiCode);assert.match(error.message,/保留业务错误码供核对/);
    assert.doesNotMatch(error.message,/private-canary|余额不足|权限不足/);
  }
});

test('plain local account, margin and leverage errors keep the specific condition instead of the generic fallback',()=>{
  const fixtures=[
    ['binance','binance: configure one-way/net position mode first',/单向.*净持仓/],
    ['binance','binance: configure isolated margin before live entry',/要求逐仓.*不会被自动切换/],
    ['binance','binance: symbol configuration unavailable',/合约.*账户配置/],
    ['binance','binance: unknown margin mode',/未识别.*保证金模式/],
    ['binance','binance: invalid symbol leverage',/杠杆字段无效/],
    ['binance','binance: invalid position quantity data',/持仓数量字段无效/],
    ['binance','binance: unable to verify requested margin mode',/所选全仓.*逐仓不一致/],
    ['binance','binance: external/pending conditional order; margin change refused',/条件挂单.*保证金模式/],
    ['binance','binance: external/pending order on BTC/USDT:USDT; entry refused',/已有挂单/],
    ['bybit','bybit: one-way positionIdx=0 must be verified',/未能确认.*positionIdx=0/],
    ['bybit','bybit: portfolio or unknown margin mode is read-only',/执行支持已确认的全仓或逐仓/],
    ['bybit','bybit: symbol position mode cannot be verified',/不能猜测单向或双向/],
    ['bybit','bybit: leverage or unchanged account mode readback failed',/杠杆或账户模式读回不一致/],
    ['bybit','bybit: configure crossed account margin before live entry',/所选全仓.*交易所调整.*不会自动切换整个账户/],
    ['bybit','bybit: configure isolated account margin before live entry',/所选逐仓.*交易所调整/],
    ['okx','okx: isolated leverage scope unavailable',/isolated.*net/],
    ['okx','okx: cross leverage scope unavailable',/全仓杠杆.*净持仓/],
    ['okx','okx: ambiguous native position margin scope; reduction refused',/不同保证金模式.*平仓/],
    ['okx','okx: unable to verify requested leverage',/杠杆读回结果与请求值不一致/],
    ['okx','okx: external/existing position on ETH/USDT:USDT; entry refused',/已有持仓/],
    ['gate','gate: incomplete position risk data',/价格.*杠杆.*强平/],
    ['gate','gate: requested isolated margin could not be verified',/逐仓模式.*读回确认/],
    ['bitget','bitget: configure one-way position mode before trading',/Classic.*单向/],
    ['bitget','bitget: configure isolated margin before trading',/Classic.*逐仓/],
    ['bitget','bitget: classic margin mode change could not be verified',/保证金模式.*读回确认/],
    ['bitget','bitget: UTA leverage or unchanged margin mode could not be verified',/UTA 杠杆读回未达到目标/],
    ['bitget','bitget: UTA isolated account has incompatible symbol margin mode',/账户为逐仓.*合约保证金模式不匹配/],
  ] as const;
  for(const [exchange,message,meaning] of fixtures){
    const error=tradingError(exchange,'合约检查',new Error(message));
    assert.match(error.message,meaning);assert.doesNotMatch(error.message,/未能确认执行条件|BTC\/|ETH\//);
  }
});

test('every venue shares exact local balance and precision explanations without echoing unsupported text',()=>{
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as const){
    assert.match(tradingError(exchange,'账户检查',new Error(`${exchange}: USDT balance unavailable`)).message,/未取得有效 USDT/);
    assert.match(tradingError(exchange,'合约检查',new Error('Order quantity does not match exchange lot size')).message,/合约张数精度/);
    assert.match(tradingError(exchange,'合约检查',new Error(`${exchange}: configure isolated margin before live entry private-canary`)).message,/未能确认执行条件/);
    assert.match(tradingError(exchange,'合约检查',new Error(`${exchange}: external/existing position on https://private-canary.invalid; entry refused`)).message,/未能确认执行条件/);
  }
});

test('message accessors and embedded response instructions never enter safe execution diagnostics',()=>{
  let reads=0;
  const getter=Object.defineProperty(new Error(),'message',{get(){reads++;throw new Error('private-canary');}});
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as const){
    assert.match(tradingError(exchange,'账户检查',getter).message,/未能确认执行条件/);
    const embedded=new Error(`${exchange} ${JSON.stringify({msg:'"retCode":10005 "code":"40014" private-canary',headers:{authorization:'private-canary'}})}`);
    const error=tradingError(exchange,'杠杆准备',embedded);
    assert.equal(error.apiCode,undefined);assert.doesNotMatch(error.message+JSON.stringify(error),/private-canary|10005|40014|headers/);
  }
  assert.equal(reads,0);
});

test('native reduction quantity, limit, precision and request guards retain fixed diagnostics for pre-submit rejection',()=>{
  const common=[
    ['Order is below minimum quantity/notional or exceeds maximum',/数量或名义金额.*上下限/],
    ['Order unit rules unavailable or conflicting',/数量步长.*规则缺失/],
    ['Order precision conversion failed',/数量或价格.*精度转换/],
    ['Order price exceeds configured limit',/价格精度.*原委托限价/],
    ['Maker reduction requires an exact PostOnly reduce-only request',/Maker 减仓.*PostOnly.*只减仓/],
    ['Maker reduction venue unsupported',/交易所.*Maker 减仓接口/],
    ['Exact Maker reduction slot unsupported',/精确分仓 Maker 减仓选择/],
    ['Unsupported Maker entry selector',/Maker 委托参数.*开平仓路径/],
    ['Unsupported exact close selector',/精确分仓平仓选择/],
  ] as const;
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as const)for(const [message,meaning] of common){
    // These adapter errors are proven local vetoes. Their private ancillary properties are not display evidence.
    const input=new OrderNotSubmittedError(message,'OFFLINE_PRIVATE_CODE_CANARY','OFFLINE_PRIVATE_REASON_CANARY');
    const diagnosis=tradingError(exchange,'合约检查',input);
    assert.match(diagnosis.message,meaning);assert.equal(diagnosis.cause,undefined);assert.equal(diagnosis.apiCode,undefined);
    assert.doesNotMatch(diagnosis.message+diagnosis.stack+JSON.stringify(diagnosis),/CANARY|未能确认执行条件/);
  }
  const native=[
    ['gate','gate: invalid position quantity',/持仓数量无效.*可减仓/],
    ['gate','gate: invalid exact close position selector',/精确平仓.*方向.*仓位身份/],
    ['gate','gate: a positive reduce-only quantity is required',/有效正数张数.*只减仓/],
    ['gate','gate: exact position for quantitative close is unavailable or ambiguous',/可唯一确认.*定量平仓/],
    ['bybit','bybit: invalid position quantity',/持仓数量无效.*可减仓/],
    ['bybit','bybit: a positive reduce-only quantity is required',/有效正数数量.*只减仓/],
    ['bybit','bybit: reduction preflight requires reduce-only',/减仓预检.*只减仓/],
    ['bybit','bybit: insufficient verified position to reduce',/已核实可减仓数量不足/],
    ['bitget','bitget: classic margin mode must be verified',/Classic.*保证金模式未确认.*执行参数/],
  ] as const;
  for(const [exchange,message,meaning] of native)assert.match(tradingError(exchange,'合约检查',new Error(message)).message,meaning);
});

test('reduction preflight diagnostics reject appended payloads, non-Error messages and forged reasons',()=>{
  const fixtures=[
    ['gate','Order unit rules unavailable or conflicting'],
    ['gate','Order is below minimum quantity/notional or exceeds maximum'],
    ['bybit','Order precision conversion failed'],
    ['bybit','Order price exceeds configured limit'],
    ['gate','Maker reduction requires an exact PostOnly reduce-only request'],
    ['gate','gate: invalid exact close position selector'],
    ['bybit','bybit: reduction preflight requires reduce-only'],
    ['bitget','bitget: classic margin mode must be verified'],
  ] as const;
  for(const [exchange,message] of fixtures)for(const input of [new Error(`${message} private-canary`),
    new Error(`${message}\n{"apiKey":"private-canary","rawBody":"private-canary"}`),new Error(`private-canary ${message}`),
    {message},new OrderNotSubmittedError('unknown raw private-canary','INVALID_ORDER_PRECISION',message)]){
    const error=tradingError(exchange,'合约检查',input);
    assert.match(error.message,/未能确认执行条件/);assert.equal(error.apiCode,undefined);assert.equal(error.cause,undefined);
    assert.doesNotMatch(error.message+error.stack+JSON.stringify(error),/private-canary|rawBody|apiKey/);
  }
  // A documented API business code remains the primary evidence if both fields are present.
  const business=tradingError('bybit','合约检查',Object.assign(new Error('Order precision conversion failed'),{apiCode:'10005'}));
  assert.equal(business.apiCode,'10005');assert.match(business.message,/当前操作权限不足/);assert.doesNotMatch(business.message,/精度转换/);
});
