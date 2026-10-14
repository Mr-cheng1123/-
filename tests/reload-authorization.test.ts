import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizedReloadExchanges} from '../src/core/reload-authorization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppState,Position} from '../src/shared/types.js';
import type {FundingOpportunitiesResponse,FundingCandidateView} from '../src/shared/funding-opportunities.js';

const now=1790872000000;
function fixtures(){
  const state={timestamp:now,config:{...defaultConfig,mode:'live'},autoEnabled:false,liveUnlocked:true,positions:[],unconfirmedOrders:[],
    liveReadiness:{exchanges:[{exchange:'gate',supported:true,credentialsConfigured:true,executionAuthorized:true},{exchange:'bitget',supported:true,credentialsConfigured:true,executionAuthorized:true},{exchange:'binance',supported:true,credentialsConfigured:false}]}} as unknown as AppState;
  const candidates={computedAt:now,status:'ready',maxAgeMs:60000,rows:[]} as unknown as FundingOpportunitiesResponse;
  return {state,candidates};
}
test('a maintenance reload preserves the exact existing venue permission without automatic entries',()=>{
  const {state,candidates}=fixtures();assert.deepEqual(authorizedReloadExchanges(state,candidates,now),['bitget','gate']);assert.equal(state.autoEnabled,false);
});
test('paused, unlocked and fresh source state are required',()=>{
  for(const change of [{autoEnabled:true},{liveUnlocked:false},{timestamp:now-16000},{config:{...defaultConfig,mode:'paper'}}]){
    const {state,candidates}=fixtures();Object.assign(state,change);assert.throws(()=>authorizedReloadExchanges(state,candidates,now));
  }
});
test('current exposure blocks reload while independently archived journal history does not',()=>{
  const {state,candidates}=fixtures();state.positions=[{id:'old',status:'attention',accountClosure:{confirmedAt:now-1}} as Position];
  state.unconfirmedOrders=[{positionId:'old',exchange:'gate',historical:true}];assert.deepEqual(authorizedReloadExchanges(state,candidates,now),['bitget','gate']);
  state.positions[0].accountClosure=undefined;assert.throws(()=>authorizedReloadExchanges(state,candidates,now));
  state.positions=[];state.unconfirmedOrders[0].historical=false;assert.throws(()=>authorizedReloadExchanges(state,candidates,now));
});
test('credential presence cannot grant permission to a new or revoked venue',()=>{
  for(const executionAuthorized of [false,undefined]){
    const {state,candidates}=fixtures();state.liveReadiness!.exchanges.push({exchange:'bybit',supported:true,credentialsConfigured:true,executionAuthorized});
    assert.throws(()=>authorizedReloadExchanges(state,candidates,now));
  }
});
test('old versions can prove an exact venue scope only with fresh passed pair authorization checks',()=>{
  const {state,candidates}=fixtures();for(const venue of state.liveReadiness!.exchanges)delete venue.executionAuthorized;
  candidates.rows=[{id:'ARK-gate-bitget',longExchange:'gate',shortExchange:'bitget',updatedAt:now,execution:{id:'ARK-gate-bitget',longExchange:'gate',shortExchange:'bitget',checks:[{group:'account',label:'两腿交易账户已授权',pass:true}]}} as FundingCandidateView];
  assert.deepEqual(authorizedReloadExchanges(state,candidates,now),['bitget','gate']);
  candidates.rows[0].execution!.checks![0].pass=false;assert.throws(()=>authorizedReloadExchanges(state,candidates,now));
  candidates.rows[0].execution!.checks![0].pass=true;candidates.rows[0].updatedAt=now-60001;assert.throws(()=>authorizedReloadExchanges(state,candidates,now));
});
