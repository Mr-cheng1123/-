import test from 'node:test';
import assert from 'node:assert/strict';
import { positionMoney, positionNumber, positionPrice, positionDate, positionTime, positionLiquidationLabel } from '../web/src/position-formatters.js';
import { liquidationObservationLabel } from '../web/src/ledger-position-metrics.js';

test('cached position formatters preserve every displayed precision and missing-data label', () => {
  for (const value of [-1000.00001, -.00005, -0, 0, .000001, 1, 1234.56789]) {
    for (const digits of [0, 2, 4, 6, 8]) assert.equal(positionNumber(value, digits), value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
    assert.equal(positionPrice(value), value.toLocaleString('en-US', { maximumFractionDigits: 8 }));
    assert.equal(positionMoney(value, true), `${value < 0 ? '−' : value > 0 ? '+' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  }
  for (const value of [undefined, NaN, Infinity]) { assert.equal(positionPrice(value), '—'); assert.equal(positionMoney(value), '—'); }
  assert.equal(positionDate(undefined), '尚未更新'); assert.equal(positionTime(undefined, '—'), '—');
  for (const value of [Date.UTC(2026, 9, 2), Date.UTC(2026, 9, 2, 12, 34, 56)]) {
    assert.equal(positionDate(value), new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    assert.equal(positionTime(value), new Date(value).toLocaleTimeString('zh-CN', { hour12: false }));
  }
  for (const liquidation of [{ status: 'available', distancePct: 34.566 }, { status: 'not_reported', reason: 'waiting' }, { status: 'flat' }, { status: 'unknown' }] as const) {
    assert.equal(positionLiquidationLabel({ liquidation }), liquidationObservationLabel({ liquidation }));
  }
});
