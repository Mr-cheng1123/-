import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../src/shared/config.js';
import { configConcurrencyKey } from '../src/shared/config-concurrency.js';
import { LocalRequestRejected, parseConfigPatch, parsePositionCloseRequest,selectedExternalExposureRecoverySchema } from '../src/server-input.js';

const close = () => ({ operationId: 'original-close-click', expiresAt: Date.now() + 45_000, base: 'CT',
  acknowledgement: 'CLOSE_SELECTED_POSITION' as const,
  legs: [{ exchange: 'gate' as const, symbol: 'CT/USDT:USDT', side: 'long' as const, quantity: 106,
    accountPositionKey: 'gate-native-slot', positionOpenedAt: 1_000_000 }] });

test('external exposure selection cannot accept a generic close or silently expand its original identity',()=>{
  const input={acknowledgement:'RESTORE_SELECTED_EXTERNAL_EXPOSURE_MANAGEMENT',expiresAt:Date.now()+45_000,positionId:'original',
    expected:{base:'DOS',openedAt:1_000_000,longExchange:'bitget',longSymbol:'DOS/USDT:USDT',longQuantity:220,
      shortExchange:'gate',shortSymbol:'DOS/USDT:USDT',shortQuantity:220}};
  assert.deepEqual(selectedExternalExposureRecoverySchema.parse(input),input);
  for(const value of [{},close(),{...input,acknowledgement:'CLOSE_SELECTED_POSITION'},
    {...input,positionIds:['another']},{...input,expected:{...input.expected,longQuantity:Infinity}},
    {...input,expected:{...input.expected,shortQuantity:0}},{...input,expected:{...input.expected,side:'long'}}])
    assert.equal(selectedExternalExposureRecoverySchema.safeParse(value).success,false);
});

test('live legacy blank close requests cannot reach the executor; paper compatibility remains', () => {
  let calls = 0;
  const dispatch = (mode: 'live' | 'paper', body: unknown) => { const request = parsePositionCloseRequest(mode, body); calls++; return request; };
  for (const body of [undefined, null, {}, { quantity: 106 }, { operationId: 'legacy-click' }]) {
    assert.throws(() => dispatch('live', body), error => error instanceof LocalRequestRejected && error.status === 409);
  }
  assert.equal(calls, 0);
  assert.equal(dispatch('paper', {}), undefined);
  const scoped = close();
  assert.deepEqual(dispatch('live', scoped), scoped);
});

test('scoped close input preserves the exact selected native quantity and refuses partial confirmations', () => {
  const input = close(), result = parsePositionCloseRequest('live', input)!;
  assert.equal(result.legs[0].quantity, 106); assert.equal(result.legs[0].accountPositionKey, 'gate-native-slot');
  for (const patch of [{ operationId: undefined }, { expiresAt: undefined }, { legs: [] },
    { legs: [{ ...input.legs[0], accountPositionKey: undefined }] }, { legs: [{ ...input.legs[0], quantity: 0 }] }]) {
    assert.throws(() => parsePositionCloseRequest('live', { ...input, ...patch }));
  }
});

test('PATCH version metadata is separated from settings and validates explicit snapshots', () => {
  const expectedConfig = validateConfig(defaultConfig);
  const input = { orderNotionalUsd: 120, expectedConfig }, parsed = parseConfigPatch(input);
  assert.deepEqual(parsed.partial, { orderNotionalUsd: 120 });
  assert.equal(configConcurrencyKey(parsed.expectedConfig!), configConcurrencyKey(expectedConfig));
  assert.equal('expectedConfig' in parsed.partial, false);
  assert.deepEqual(input.expectedConfig, expectedConfig, 'Parsing does not mutate the caller snapshot.');
  assert.deepEqual(parseConfigPatch({ orderNotionalUsd: 130 }), { partial: { orderNotionalUsd: 130 } });
  for (const bad of [null, undefined, false, 'current', {}, []]) assert.throws(() => parseConfigPatch({ orderNotionalUsd: 120, expectedConfig: bad }));
  for (const bad of [null, undefined, [], 120]) assert.throws(() => parseConfigPatch(bad));
});

test('configuration comparison ignores object insertion order, retains arrays and every fee value', () => {
  const config = validateConfig(defaultConfig);
  const reversed = Object.fromEntries(Object.entries(config).reverse()) as typeof config;
  reversed.takerFees = Object.fromEntries(Object.entries(config.takerFees).reverse()) as typeof config.takerFees;
  assert.equal(configConcurrencyKey(config), configConcurrencyKey(reversed));
  assert.notEqual(configConcurrencyKey(config), configConcurrencyKey({ ...config, symbols: [...config.symbols].reverse() }));
  assert.notEqual(configConcurrencyKey(config), configConcurrencyKey({ ...config, takerFees: { ...config.takerFees, bybit: .00049 } }));
});
