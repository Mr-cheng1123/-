import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from './legacy-config.js';
import { isFeeOnly } from '../src/shared/strategy-profile.js';
import { calculateFundingCandidates } from '../src/shared/funding-opportunities.js';
import { calculateOpportunities } from '../src/core/strategy.js';
import { evaluateHoldingDecision } from '../src/core/holding-decision.js';
import { runBacktest } from '../src/core/backtest.js';
import { ReadyHistory } from './ready-history.js';
import type { AppConfig, ExchangeId, HistoricalRow, MarketSnapshot, Position } from '../src/shared/types.js';
import type { FundingStatsCell, FundingStatsDataset } from '../src/shared/funding-statistics.js';

const now=1_700_000_000_000;
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
const settings=(extra:Partial<AppConfig>={}):AppConfig=>({...defaultConfig,mode:'live',feeOnly:true,orderNotionalUsd:100,
  holdMode:'adaptive',minNetProfitUsd:100,minNetRateBps:1000,maxPositionPerCoinUsd:1,maxTotalPositionUsd:1,
  leverage:4,maxLeverage:1,maxDeltaUsd:0,fundingSafetyFactor:.01,transferCostUsd:100,rebalanceCostUsd:100,basisStressBps:1000,...extra});
const quote=(exchange:ExchangeId,extra:Partial<MarketSnapshot>={}):MarketSnapshot=>({exchange,base:'HANMI',symbol:'HANMI/USDT:USDT',timestamp:now,
  takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange',
  markPrice:100,indexPrice:100,fundingRate:exchange==='okx'?-.008151:0,nextFundingTime:now+7_200_000,intervalHours:exchange==='gate'?4:8,
  fundingHistory:[],bids:[{price:99.7,quantity:100}],asks:[{price:100.3,quantity:100}],openInterestUsd:0,volume24hUsd:0,
  quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,source:'public',predictedFundingRate:exchange==='okx'?.01:-.01,...extra});
const cell=(exchange:ExchangeId,extra:Partial<FundingStatsCell>={}):FundingStatsCell=>({exchange,rate:exchange==='okx'?-.008151:0,
  intervalHours:exchange==='gate'?4:8,nextFundingTime:now+7_200_000,updatedAt:now,timestampKind:'received',available:true,
  openInterestUsd:0,volume24hUsd:0,predictedRate:exchange==='okx'?.01:-.01,...extra});
const dataset=(cells:FundingStatsCell[]=[cell('okx'),cell('gate',{nextFundingTime:now+10_800_000})]):FundingStatsDataset=>({source:'exchanges',range:'current',status:'ready',
  rows:[{base:'HANMI',cells:Object.fromEntries(cells.map(value=>[value.exchange,value]))}],receivedAt:now,lastAttemptAt:now,nextRefreshAt:now+20_000,
  maxAgeMs:120_000,sourceUrl:'https://example.test',marginScope:'USDT'});

test('fee-only is a live-compatible forecast profile while legacy paper behavior stays scoped',()=>{
  const {feeOnly,...legacy}=defaultConfig;
  assert.equal(validateConfig(legacy).feeOnly,true);
  assert.equal(validateConfig(legacy).paperFeeOnly,false);
  assert.equal(isFeeOnly(defaultConfig),false);
  assert.equal(isFeeOnly({...defaultConfig,paperFeeOnly:true}),true);
  assert.equal(isFeeOnly({...defaultConfig,mode:'live',feeOnly:true,paperFeeOnly:true}),true);
  const c=validateConfig(settings());
  assert.equal(c.mode,'live');assert.equal(c.autoEnabled,false);assert.equal(isFeeOnly(c),true);
  assert.equal(validateConfig({...c,paperFeeOnly:true}).paperFeeOnly,false);
  assert.equal(validateConfig({...c,feeOnly:false}).feeOnly,true);
  assert.throws(()=>validateConfig({...c,dataSource:'demo'}),/公开实时行情/);
});

test('HANMI live statistics preserve funding but do not guess private four-trade fees',()=>{
  const [candidate]=calculateFundingCandidates(dataset(),settings(),now);
  assert.equal(candidate.longExchange,'okx');assert.equal(candidate.shortExchange,'gate');
  near(candidate.grossFundingUsd,.8151);assert.ok(Number.isNaN(candidate.feesUsd));assert.ok(Number.isNaN(candidate.expectedNetUsd));
  assert.ok(Number.isNaN(candidate.afterFeesUsd));assert.equal(candidate.candidateEligible,true);
  const [simulation]=calculateFundingCandidates(dataset(),settings({mode:'paper'}),now);
  near(simulation.feesUsd,.2);near(simulation.afterFeesUsd,.6151);near(simulation.expectedNetUsd,.6151);
  assert.deepEqual([candidate.fundingHaircutUsd,candidate.slippageBudgetUsd,candidate.transferCostUsd,candidate.basisReserveUsd],[0,0,0,0]);
  assert.ok(!candidate.reasons.some(reason=>/纸面|持仓量|成交额|风险/.test(reason)));
});

test('live fee-only book verification ignores optional screens and keeps observed price impact separate',()=>{
  const history=new ReadyHistory();
  const [opportunity]=calculateOpportunities([quote('okx'),quote('gate',{nextFundingTime:now+10_800_000})],settings(),now,history);
  assert.equal(opportunity.eligible,true,opportunity.reasons.join(','));
  assert.equal(opportunity.longQuantity,opportunity.shortQuantity);near(opportunity.expectedFundingUsd,.8151);
  near(opportunity.feesUsd,.2);
  assert.deepEqual([opportunity.slippageUsd,opportunity.transferCostUsd,opportunity.basisStressUsd],[0,0,0]);
  const [notional]=calculateOpportunities([quote('okx'),quote('gate',{markPrice:110})],settings({hedgeMode:'notional'}),now,history);
  assert.equal(notional.eligible,true,notional.reasons.join(','));assert.equal(notional.longQuantity,notional.shortQuantity);
});

test('fee-only still requires executable quantity, valid fresh prices and reachable future settlements',()=>{
  for(const change of [{asks:[]},{asks:[{price:100,quantity:.5}]},{timestamp:now-120_001},{timestamp:now+6000},
    {nextFundingTime:now},{nextFundingTime:NaN},{minNotional:101},{minQuantity:2}]){
    const [opportunity]=calculateOpportunities([quote('okx',change),quote('gate')],settings(),now,new ReadyHistory());
    assert.equal(opportunity.eligible,false,JSON.stringify(change));
  }
  assert.equal(calculateOpportunities([quote('okx'),quote('gate')],settings({maxHoldHours:1}),now,new ReadyHistory())[0].eligible,true);
  assert.deepEqual(calculateOpportunities([quote('okx',{base:'OTHER'}),quote('gate')],settings(),now),[]);
  assert.deepEqual(calculateFundingCandidates({...dataset(),receivedAt:now-120_001},settings(),now),[]);
});

test('zero gross funding cannot become a statistical candidate just by removing budgets',()=>{
  for(const rate of [0,.001]){
    const [candidate]=calculateFundingCandidates(dataset([cell('okx',{rate}),cell('gate',{rate})]),settings(),now);
    assert.equal(candidate.candidateEligible,false);near(candidate.grossFundingUsd,0);
    assert.ok(Number.isNaN(candidate.feesUsd)&&Number.isNaN(candidate.expectedNetUsd));
    const [opportunity]=calculateOpportunities([quote('okx',{fundingRate:rate}),quote('gate',{fundingRate:rate})],settings(),now,new ReadyHistory());
    assert.equal(opportunity.eligible,false);
  }
});

const position=():Position=>({id:'fee-only-hold',base:'HANMI',mode:'live',feeOnly:true,status:'open',openedAt:now-1000,plannedExitAt:now+7_210_000,holdMode:'adaptive',
  long:{exchange:'okx',symbol:'HANMI/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:999,liquidationDistancePct:null},
  short:{exchange:'gate',symbol:'HANMI/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:999,liquidationDistancePct:null},
  fundingUsd:0,feesUsd:1998,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:-1998,deltaUsd:0,fundingEvents:[],riskReasons:[]});

test('continuation holds when the next funding covers the two exit fees and ignores a holding-time cap',()=>{
  for(const [rate,action] of [[-.01,'hold'],[0,'close'],[.000001,'close']] as const){
    const result=evaluateHoldingDecision(position(),quote('okx',{fundingRate:rate}),quote('gate'),settings(),now);
    assert.equal(result.action,action,String(rate));near(result.expectedFundingUsd,-100*rate);near(result.incrementalCostUsd,.1);
  }
  assert.equal(evaluateHoldingDecision(position(),quote('okx',{timestamp:now-120_001}),quote('gate'),settings(),now).action,'wait');
  const expired=evaluateHoldingDecision(position(),quote('okx',{fundingRate:-.01}),quote('gate'),settings({maxHoldHours:1/3600}),now);
  assert.equal(expired.action,'hold');assert.equal(expired.forceClose,undefined);
});

test('fee-only replay skips synthetic cost reserves but records actual quoted spread and all fees for either supported hold mode',()=>{
  const rows:HistoricalRow[]=[];
  for(const at of [0,1000])for(const exchange of ['okx','gate'] as const)rows.push({timestamp:at,exchange,base:'HANMI',markPrice:100,
    fundingRate:exchange==='okx'?-.01:0,nextFundingTime:at+1000,intervalHours:8,bidPrice:99,askPrice:101,openInterestUsd:0,volume24hUsd:0,
    ...(at===1000?{settledFundingRate:exchange==='okx'?-.01:0}:{})});
  for(const holdMode of ['once','continuous'] as const){
    const result=runBacktest(rows,settings({holdMode,symbols:['HANMI'],exchanges:['okx','gate'],exitDelaySec:0,exitSlippageBps:200}));
    assert.equal(result.trades,1);near(result.fundingUsd,1);near(result.feesUsd,.2);near(result.spreadPnlUsd,-4);near(result.netPnlUsd,-3.2);
    near(result.closedTrades[0].netPnlUsd,result.netPnlUsd);
  }
  assert.throws(()=>runBacktest(rows,settings()),/自主判断持仓暂不支持/);
});
