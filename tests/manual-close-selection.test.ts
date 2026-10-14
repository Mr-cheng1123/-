import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountPosition, AccountState, ExchangeId } from '../src/shared/types.js';
import { selectManualCloseLegs, type ManualCloseLegTarget } from '../src/core/manual-close-selection.js';
import { accountPositionKey } from '../web/src/account-position-identity.js';

const position = (side: 'long' | 'short', changes: Partial<AccountPosition> = {}): AccountPosition => ({
  base: 'CT', symbol: 'CT/USDT:USDT', side, quantity: 106, markPrice: .5, entryPrice: .51,
  liquidationPrice: 0, leverage: 2, marginMode: 'crossed', positionOpenedAt: 1_000_000, ...changes,
});
const target = (exchange: ExchangeId, row: AccountPosition): ManualCloseLegTarget => ({ exchange,
  symbol: row.symbol, side: row.side, quantity: row.quantity, accountPositionKey: accountPositionKey(exchange, row),
  ...(row.positionOpenedAt === undefined ? {} : { positionOpenedAt: row.positionOpenedAt }),
});
const accounts = (...items: [ExchangeId, AccountPosition[]][]) => new Map<ExchangeId, AccountState>(
  items.map(([exchange, positions]) => [exchange, { freeUsd: 100, equityUsd: 100, positions }]));

test('exact unique account rows preserve 106 coins and native position IDs without altering original reads', () => {
  const long = position('long', { positionId: '12345678901234567890' }), short = position('short');
  const reads = accounts(['gate', [long]], ['bitget', [short]]), before = structuredClone(reads);
  const selected = selectManualCloseLegs('CT', [target('gate', long), target('bitget', short)], reads);
  assert.deepEqual(selected.map(item => item.position.quantity), [106, 106]);
  assert.equal(selected[0].position.positionId, long.positionId);
  assert.notEqual(selected[0].position, long);
  assert.deepEqual(reads, before);
});

test('a single observed position needs no fabricated opposite zero leg', () => {
  const row = position('short');
  assert.equal(selectManualCloseLegs('CT', [target('bybit', row)], accounts(['bybit', [row]])).length, 1);
  assert.throws(() => selectManualCloseLegs('CT', [{ ...target('bybit', row), symbol: 'CT/USDT:USDT#display-absent-long', quantity: 0 }], accounts(['bybit', [row]])), /选择无效/);
});

test('already-flat exact directions return no leg while the opposite direction is untouched', () => {
  const long = position('long'), short = position('short');
  const reads = accounts(['gate', [short]], ['bitget', [short]]);
  const selected = selectManualCloseLegs('CT', [target('gate', long), target('bitget', short)], reads);
  assert.deepEqual(selected.map(item => item.exchange), ['bitget']);
  assert.deepEqual(selectManualCloseLegs('CT', [target('gate', long)], reads), []);
  assert.throws(() => selectManualCloseLegs('CT', [target('okx', long)], reads), /未完整读取/);
});

test('merged splits, indistinguishable rows and changed PID or margin mode cannot be treated as one close target', () => {
  const row = position('long', { positionId: '100' }), chosen = target('gate', row);
  for (const actual of [[{ ...row, splitPositionCount: 2 }], [row, { ...row, positionId: '101' }]]) {
    assert.throws(() => selectManualCloseLegs('CT', [chosen], accounts(['gate', actual])), /多个分仓/);
  }
  for (const patch of [{ positionId: '101' }, { marginMode: 'isolated' as const }, { base: 'OTHER' }]) {
    assert.throws(() => selectManualCloseLegs('CT', [chosen], accounts(['gate', [{ ...row, ...patch }]])), /身份或保证金模式已变化/);
  }
});

test('a reused row key from a later opening cycle or changed amount requires a fresh explicit selection', () => {
  const row = position('long'), chosen = target('gate', row);
  assert.throws(() => selectManualCloseLegs('CT', [chosen], accounts(['gate', [{ ...row, positionOpenedAt: 2_000_000 }]])), /另一个持仓周期/);
  for (const quantity of [100, 107, 106.00001]) assert.throws(() => selectManualCloseLegs('CT', [chosen], accounts(['gate', [{ ...row, quantity }]])), /数量已变化/);
  assert.equal(selectManualCloseLegs('CT', [chosen], accounts(['gate', [{ ...row, quantity: 106 + Number.EPSILON * 106 }]]))[0].position.quantity > 106, true);
});

test('only an explicit server native-split capability admits an exact aggregate, without relaxing quantity or identity checks', () => {
  const row = position('long', { quantity: 55_620, splitPositionCount: 2, marginMode: undefined, positionOpenedAt: undefined });
  const chosen = target('gate', row), options = { allowNativeSplit: new Set<ExchangeId>(['gate']) };
  assert.equal(selectManualCloseLegs('CT', [chosen], accounts(['gate', [row]]), options)[0].position.quantity, 55_620);
  assert.throws(() => selectManualCloseLegs('CT', [chosen], accounts(['gate', [{ ...row, quantity: 60_000 }]]), options), /数量已变化/);
  assert.throws(() => selectManualCloseLegs('CT', [chosen], accounts(['gate', [row, row]]), options), /多个分仓/);
  assert.throws(() => selectManualCloseLegs('CT', [target('bitget', row)], accounts(['bitget', [row]]), options), /多个分仓/);
});

test('an invalid response cannot masquerade as an empty position; selectors must be canonical and internally consistent', () => {
  const row = position('long'), chosen = target('gate', row);
  for (const quantity of [NaN, -1, Infinity]) assert.throws(() => selectManualCloseLegs('CT', [chosen], accounts(['gate', [{ ...row, quantity }]])), /持仓返回无效/);
  for (const invalid of [{ ...chosen, accountPositionKey: '[]' }, { ...chosen, accountPositionKey: accountPositionKey('bybit', row) },
    { ...chosen, accountPositionKey: ' ' + chosen.accountPositionKey }, { ...chosen, quantity: Infinity }]) {
    assert.throws(() => selectManualCloseLegs('CT', [invalid], accounts(['gate', [row]])), /选择无效/);
  }
});

test('same-venue/same-direction groups are invalid, while explicit reductions of same-ticker assets remain possible', () => {
  const long = position('long'), short = position('short'), reads = accounts(['gate', [long, short]], ['bybit', [long, short]]);
  assert.throws(() => selectManualCloseLegs('CT', [target('gate', long), target('gate', short)], reads), /不同交易所/);
  assert.throws(() => selectManualCloseLegs('CT', [target('gate', long), target('bybit', long)], reads), /不同交易所/);
  const edgeLong = position('long', { base: 'EDGE', symbol: 'EDGE/USDT:USDT' }), edgeShort = position('short', { base: 'EDGE', symbol: 'EDGE/USDT:USDT' });
  const edgeReads = accounts(['gate', [edgeLong]], ['bybit', [edgeShort]]);
  assert.equal(selectManualCloseLegs('EDGE', [target('gate', edgeLong), target('bybit', edgeShort)], edgeReads).length, 2);
  assert.equal(selectManualCloseLegs('EDGE', [target('gate', edgeLong)], edgeReads).length, 1);
});
