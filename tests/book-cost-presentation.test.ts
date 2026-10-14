import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Opportunity, RoundTripBookCost } from '../src/shared/types.js';
import type { FundingCandidateView } from '../src/shared/funding-opportunities.js';
import BookCostBreakdown from '../web/src/BookCostBreakdown.js';
import { bookCostMoney, bookCostScope, bookPrice, firstBatchBookCostCaption, opportunityBookLoss } from '../web/src/book-cost-presentation.js';
import { candidateProfit } from '../web/src/candidate-profit.js';

const cost = (quantity = 100): RoundTripBookCost => ({ quantity, longObservedAt: 1791000000000, shortObservedAt: 1791000001000,
  longOpenPrice: .002037, longClosePrice: .002035, shortOpenPrice: .00215, shortClosePrice: .0021501,
  openingSpreadCostUsd: .00008 * quantity / 100, openingDepthImpactUsd: .00002 * quantity / 100,
  closingSpreadCostUsd: .00009 * quantity / 100, closingDepthImpactUsd: .00002 * quantity / 100,
  openingCostUsd: .0001 * quantity / 100, closingCostUsd: .00011 * quantity / 100, roundTripBookLossUsd: .00021 * quantity / 100, feesUsd: .0005 * quantity / 100 });
const opportunity = (): Opportunity => ({ entryPolicy: 'aligned', longExchange: 'gate', shortExchange: 'bitget', longQuantity: 100,
  expectedFundingUsd: .01, feesUsd: .0005, feesSource: 'exchange', bookCost: cost(),
  // A deliberately inconsistent old total must not replace the positive cost evidence.
  combinedExpectedNetUsd: 999, spreadAdvantage: { status: 'ready', estimateMethod: 'current-book', expectedSpreadPnlUsd: -999 },
  entryBatch: { pricing: 'best-opposite', targetQuantity: 100, batchQuantity: 20, longLimitPrice: .002037, shortLimitPrice: .00215,
    bookCost: { ...cost(20), roundTripBookLossUsd: .000042, feesUsd: .0001 }, expectedFundingUsd: .002, expectedNetUsd: .001858 },
} as Opportunity);
const markup = (value: Opportunity) => renderToStaticMarkup(createElement(BookCostBreakdown, { opportunity: value }));

test('aligned reference keeps positive book costs as diagnostics without deducting them from funding minus fees', () => {
  const execution = opportunity(), before = structuredClone(execution);
  const profit = candidateProfit({ execution } as FundingCandidateView, { requireNative: true });
  assert.equal(profit.bookLossUsd, .00021); assert.equal(profit.spreadUsd, -.00021);
  assert.ok(Math.abs(profit.combinedNetUsd! - (.01 - .0005)) < 1e-12);
  assert.deepEqual(execution, before);
});

test('legacy current-book costs convert once while historical spread gains retain their sign', () => {
  const execution = opportunity(); delete execution.bookCost;
  execution.spreadAdvantage!.expectedSpreadPnlUsd = -.04;
  assert.equal(opportunityBookLoss(execution), .04);
  assert.equal(candidateProfit({ execution } as FundingCandidateView).bookLossUsd, .04);
  execution.entryPolicy = 'dual'; execution.spreadAdvantage!.estimateMethod = 'historical-median';
  execution.spreadAdvantage!.expectedSpreadPnlUsd = .4;
  assert.equal(opportunityBookLoss(execution), null);
  const profit = candidateProfit({ execution } as FundingCandidateView);
  assert.equal(profit.bookLossUsd, null); assert.equal(profit.spreadUsd, .4);
  assert.equal(markup(execution), '');
});

test('small contract prices and costs remain readable rather than appearing as zero dollars', () => {
  assert.equal(bookPrice(.002037), '$0.002037'); assert.equal(bookPrice(.000000012345), '$0.000000012345');
  assert.equal(bookCostMoney(.00021), '$0.00021'); assert.equal(bookCostMoney(0), '$0.00');
  assert.equal(bookCostMoney(null), '待计算'); assert.equal(bookCostMoney(-.01), '待计算');
  assert.equal(bookCostScope(opportunity()), '完整目标 100 币');
});

test('rendered estimate separates first batch from full target using exact estimator prices, quantities and clocks', () => {
  const execution = opportunity(), html = markup(execution);
  assert.match(html, /完整目标盘口成本依据/); assert.match(html, /当前首批盘口成本依据/);
  assert.match(html, /两腿各 100 币/); assert.match(html, /两腿各 20 币/);
  assert.match(html, /\$0\.00021/); assert.match(html, /\$0\.000042/);
  for (const price of ['0.002037', '0.002035', '0.00215', '0.0021501']) assert.ok(html.includes(`$${price}`));
  assert.match(html, /采样：多腿 10\/03 12:00:00；空腿 10\/03 12:00:01/);
  assert.match(html, /本批四笔手续费（独立估计）/); assert.match(html, /本批单轮净收益（条件参考）/);
  assert.match(html, /买卖差按各交易所盘口中间价计量/); assert.match(html, /不含手续费/);
  assert.doesNotMatch(html, /[+−]\$0\.00021/); assert.doesNotMatch(html, /[+−]\$0\.000042/);
  assert.equal(firstBatchBookCostCaption(execution), '首批 20 币 · 盘口损耗 $0.000042');
});

test('incomplete closing depth displays its reason and never fabricates a free round trip or batch total', () => {
  const execution = opportunity(); delete execution.bookCost; delete execution.entryBatch!.bookCost;
  execution.spreadAdvantage = { ...execution.spreadAdvantage!, status: 'warming', expectedSpreadPnlUsd: null,
    reason: '完整平仓盘口不足，不能估计整笔成交成本' };
  const profit = candidateProfit({ execution } as FundingCandidateView);
  assert.equal(profit.bookLossUsd, null); assert.ok(Math.abs(profit.combinedNetUsd! - (.01 - .0005)) < 1e-12);
  const html = markup(execution);
  assert.match(html, /完整平仓盘口不足/); assert.match(html, /待计算/);
  assert.doesNotMatch(html, /只有损耗汇总|\$0\.00/); assert.equal(firstBatchBookCostCaption(execution), null);
});

test('a warming full target ignores retained old evidence while its independently priced first batch remains visible', () => {
  const execution = opportunity(); execution.spreadAdvantage!.status = 'warming';
  execution.spreadAdvantage!.reason = '完整目标平仓盘口不足';
  assert.equal(opportunityBookLoss(execution), null);
  assert.ok(Math.abs(candidateProfit({ execution } as FundingCandidateView).combinedNetUsd! - (.01 - .0005)) < 1e-12);
  const html = markup(execution); assert.match(html, /完整目标平仓盘口不足/);
  assert.match(html, /当前首批盘口成本依据/); assert.match(html, /\$0\.000042/);
  assert.doesNotMatch(html, /<strong>\$0\.00021<\/strong>/);
});

test('an equal first batch and target use one evidence card and unknown fees stay unknown', () => {
  const execution = opportunity(); execution.entryBatch!.batchQuantity = 100;
  execution.entryBatch!.bookCost = execution.bookCost; execution.bookCost!.feesUsd = null;
  assert.equal(firstBatchBookCostCaption(execution), null);
  const html = markup(execution);
  assert.match(html, /当前首批与完整目标数量相同/); assert.doesNotMatch(html, /当前首批盘口成本依据/);
  execution.feesSource = 'pending'; execution.feesUsd = NaN;
  const profit = candidateProfit({ execution } as FundingCandidateView, { requireNative: true });
  assert.equal(profit.feesUsd, null); assert.equal(profit.combinedNetUsd, null); assert.equal(profit.bookLossUsd, .00021);
});
