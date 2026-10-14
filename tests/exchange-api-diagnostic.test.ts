import test from 'node:test';
import assert from 'node:assert/strict';
import {safeExchangeApiMessage,sanitizeApiMessage} from '../src/shared/exchange-api-diagnostic.js';
import {configureExchangeTransport,ExchangeNetworkError,getExchangeNetworkStatus} from '../src/adapters/network.js';

const nativeMessage='Native contract agreement validation rejected';
const payload=(retMsg:unknown,extra:object={})=>({retCode:110126,retMsg,result:{unselected:'unselected-payload-canary'},...extra});
const rawError=(retMsg:unknown)=>Object.assign(new Error(`bybit ${JSON.stringify(payload(retMsg))}`),
  {name:'ExchangeError',headers:{authorization:'header-canary'},requestBody:'body-canary'});

test('diagnostic extraction retains only native Bybit retMsg and never the complete payload',()=>{
  const error=rawError(nativeMessage);
  assert.equal(safeExchangeApiMessage('bybit',error),nativeMessage);
  assert.doesNotMatch(JSON.stringify({apiMessage:safeExchangeApiMessage('bybit',error)}),/unselected|headers|authorization|requestBody|body-canary/);
  assert.equal(safeExchangeApiMessage('bybit',payload(nativeMessage)),nativeMessage);
});

test('native diagnostic text is bounded at 240 characters and control characters are normalized',()=>{
  const result=sanitizeApiMessage(`Native\ncontract\tvalidation\u0000 ${'detail '.repeat(100)}`);
  assert.equal(typeof result,'string');assert.equal(result!.length,240);
  assert.match(result!,/^Native contract validation /);assert.doesNotMatch(result!,/[\u0000-\u001f\u007f]/);
  assert.equal(sanitizeApiMessage(' \n\t '),undefined);
});

test('unsupported and excessive diagnostic values cannot become persisted business text',()=>{
  for(const value of [undefined,null,0,{},[],true,'x'.repeat(65537)])assert.equal(sanitizeApiMessage(value),undefined);
  assert.equal(safeExchangeApiMessage('bybit',rawError('x'.repeat(65537))),undefined);
  assert.equal(safeExchangeApiMessage('bybit',new Error('Native contract validation detail')),undefined);
  assert.equal(safeExchangeApiMessage('bybit',new Error('bybit {broken json')),undefined);
  assert.equal(safeExchangeApiMessage('bybit',new Error('bybit {"retMsg":"unproved detail"}')),undefined);
});

test('known client key secret and passphrase values are redacted even without field labels',()=>{
  const values=['client-key-canary','client-secret-canary','client-pass-canary'];
  const message=safeExchangeApiMessage('bybit',rawError(`Native validation ${values.join(' ')}`),values);
  assert.match(message!,/Native validation/);
  for(const value of values)assert.ok(!message!.includes(value));
});

for(const [field,value,quote] of [
  ['apiKey','ak','"'],['accessToken','at','"'],['api_secret','as','"'],['passphrase','pp','"'],
  ['api-key','a','\''],['access_token','b','\''],['password','c','\''],['X-BAPI-SIGN','d','"'],
] as const)test(`short quoted ${field} values are removed from retained API diagnostics`,()=>{
  const message=safeExchangeApiMessage('bybit',rawError(`Native validation {${quote}${field}${quote}:${quote}${value}${quote}}`));
  assert.match(message!,/Native validation/);assert.match(message!,/\[redacted\]/);
  assert.ok(!message!.includes(`${quote}${value}${quote}`));
});

test('native diagnostic URLs opaque tokens and long numeric account identifiers are not retained',()=>{
  const result=sanitizeApiMessage('Native validation https://user:pass@private.invalid/path?apiKey=opaque aBcd0123456789_opaqueTokenCanary 1791524201229000');
  assert.match(result!,/Native validation/);assert.doesNotMatch(result!,/private\.invalid|opaque|1791524201229000|user:pass/);
});

test('other venue metadata and foreign venue CCXT prefixes cannot supply Bybit diagnostic text',()=>{
  assert.equal(safeExchangeApiMessage('gate',rawError(nativeMessage)),undefined);
  assert.equal(safeExchangeApiMessage('bybit',Object.assign(rawError(nativeMessage),{exchange:'okx'})),undefined);
  assert.equal(safeExchangeApiMessage('bybit',new Error(`okx ${JSON.stringify(payload(nativeMessage))}`)),undefined);
  assert.equal(safeExchangeApiMessage('bybit',new Error(`binanceusdm ${JSON.stringify(payload(nativeMessage))}`)),undefined);
});

test('foreign venue CCXT prefixes cannot be overridden by direct retMsg or apiMessage fields',()=>{
  for(const prefix of ['okx','binance','binanceusdm','binancecoinm','gate','gateio','bitget'])
  for(const fields of [{retCode:110126,retMsg:'foreign-message-canary'},{apiMessage:'foreign-message-canary'}]){
    const error=Object.assign(new Error(`${prefix} {"code":"51008","msg":"foreign source"}`),fields);
    assert.equal(safeExchangeApiMessage('bybit',error),undefined);
  }
});

test('hostile native diagnostic getters are not invoked',()=>{
  let reads=0;
  const hostile=()=>{reads++;throw new Error('getter-canary');};
  const error=Object.defineProperties(new Error('unknown'),{
    retCode:{get:hostile},retMsg:{get:hostile},apiMessage:{get:hostile},exchange:{get:hostile},message:{get:hostile},
  });
  assert.equal(safeExchangeApiMessage('bybit',error),undefined);assert.equal(reads,0);
  const direct=Object.defineProperty({retCode:110126},'retMsg',{get:hostile});
  assert.equal(safeExchangeApiMessage('bybit',direct),undefined);assert.equal(reads,0);
});

test('real transport wrapper preserves bounded retMsg without raw response error or extra POST',async()=>{
  let calls=0;
  const client:any={apiKey:'client-key-canary',secret:'client-secret-canary',password:'client-pass-canary',
    fetch:async()=>{calls++;throw rawError(`${nativeMessage}; client-key-canary client-secret-canary client-pass-canary`);}};
  configureExchangeTransport(client,'bybit');
  await assert.rejects(client.fetch('https://api.bybit.com/v5/order/create','POST',
    {authorization:'header-canary'},JSON.stringify({category:'linear',orderLinkId:'fa01234567890123456789012345'})),error=>{
    assert.ok(error instanceof ExchangeNetworkError);assert.equal(error.code,'API_ERROR');assert.equal(error.apiCode,'110126');
    assert.match(error.apiMessage!,/Native contract agreement validation rejected/);assert.ok(error.apiMessage!.length<=240);
    const stored=JSON.stringify(error);assert.doesNotMatch(stored,/canary|unselected|headers|authorization|requestBody|api\.bybit\.com/);
    assert.doesNotMatch(error.message+error.stack,/canary|unselected|authorization|api\.bybit\.com/);
    assert.equal(error.cause,undefined);assert.equal(safeExchangeApiMessage('bybit',error),error.apiMessage);return true;
  });
  assert.equal(calls,1);assert.equal(client.maxRetriesOnFailure,0);assert.equal(client.options.maxRetriesOnFailure,0);
  assert.equal(getExchangeNetworkStatus(client)?.errorCode,undefined);
});

test('real transport wrapper strips short quoted credential fields from native retMsg',async()=>{
  let calls=0;const client:any={fetch:async()=>{calls++;throw rawError('Native validation {"apiKey":"ak","accessToken":"at","api_secret":"as","passphrase":"pp"}');}};
  configureExchangeTransport(client,'bybit');
  await assert.rejects(client.fetch('https://api.bybit.com/v5/order/create','POST'),error=>{
    assert.ok(error instanceof ExchangeNetworkError);assert.equal(error.code,'API_ERROR');assert.equal(error.apiCode,'110126');
    assert.match(error.apiMessage!,/Native validation/);
    for(const value of ['"ak"','"at"','"as"','"pp"'])assert.ok(!JSON.stringify(error).includes(value));return true;
  });assert.equal(calls,1);
});

test('timeout carrying code 110126 keeps uncertainty without retaining native business text or retrying POST',async()=>{
  let calls=0;const client:any={fetch:async()=>{calls++;const error=rawError(nativeMessage);error.name='RequestTimeout';throw error;}};
  configureExchangeTransport(client,'bybit');
  await assert.rejects(client.fetch('https://api.bybit.com/v5/order/create','POST'),error=>{
    assert.ok(error instanceof ExchangeNetworkError);assert.equal(error.code,'TIMEOUT');assert.equal(error.apiCode,'110126');
    assert.equal(error.apiMessage,undefined);assert.equal(safeExchangeApiMessage('bybit',error),undefined);
    assert.doesNotMatch(JSON.stringify(error)+error.message,/agreement|validation|unselected|canary/);return true;
  });assert.equal(calls,1);
  assert.equal(new ExchangeNetworkError('TIMEOUT',0,'110126','bybit',nativeMessage).apiMessage,undefined);
});
