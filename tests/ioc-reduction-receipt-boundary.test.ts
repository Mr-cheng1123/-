import assert from 'node:assert/strict';
import test from 'node:test';
import {hasOrderReceiptIdentity,isProvenNoSubmitReceipt,isTerminalOrderReceipt,normalizeOrderReceipt} from '../src/shared/order-receipt-validity.js';
import {isUnconfirmedJournalOrder} from '../src/shared/ledger-lifecycle.js';
import type {JournalOrder,OrderRequest,OrderResult} from '../src/shared/types.js';

const now=1_791_697_000_000;
const request:OrderRequest={clientOrderId:'ioc-reduction-local-veto',base:'CVC',symbol:'CVC/USDT:USDT',side:'sell',quantity:10,limitPrice:.03,reduceOnly:true};
const veto=(patch:Partial<OrderResult>={}):OrderResult=>({id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
  timestamp:now,rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED',...patch});
const unknown=(patch:Partial<OrderResult>={}):OrderResult=>({id:'',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:now-1000,...patch});

test('witnessed new IOC reduction veto is known zero and not an unresolved journal',()=>{
  const result=veto();
  assert.equal(isProvenNoSubmitReceipt(request,result),true);
  assert.equal(hasOrderReceiptIdentity(request,result),true);
  assert.equal(isTerminalOrderReceipt(request,result),true);
  assert.equal(normalizeOrderReceipt(request,result,now).status,'cancelled');
  const journal:JournalOrder={positionId:'local-ioc-reduction-position',exchange:'gate',request,createdAt:now-1,result,
    executionEvidence:{version:1,method:'ioc',role:'exit',batchId:'local-ioc-reduction-batch',bookedFeeUsd:0}};
  assert.equal(isUnconfirmedJournalOrder(journal),false);
});

test('new IOC veto cannot authorize entry or a PostOnly Maker intent',()=>{
  for(const other of [{...request,reduceOnly:false},{...request,postOnly:true}]){
    assert.equal(isProvenNoSubmitReceipt(other,veto()),false);
    assert.equal(normalizeOrderReceipt(other,veto(),now).status,'unknown');
  }
});

test('generic, prefixed, suffixed and similar strings cannot forge the IOC local-veto code',()=>{
  for(const rejectionCode of ['ORDER_SUBMISSION_PERMISSION_CHANGED','IOC_REDUCTION_PERMISSION_CHANGED_EXTRA',
    'FAKE_IOC_REDUCTION_PERMISSION_CHANGED','IOC_REDUCTION_PERMISSION_CHANGE','ioc_reduction_permission_changed']){
    const forged=veto({rejectionCode});
    assert.equal(isProvenNoSubmitReceipt(request,forged),false,rejectionCode);
    assert.equal(normalizeOrderReceipt(request,forged,now).status,'unknown',rejectionCode);
  }
});

test('diagnostic apiCode does not turn an unknown order into a known local zero',()=>{
  const unresolved=unknown({rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED',confirmation:{stage:'order-read',reason:'not-found',apiCode:'IOC_REDUCTION_PERMISSION_CHANGED',observedAt:now}});
  assert.equal(isProvenNoSubmitReceipt(request,unresolved),false);
  assert.equal(normalizeOrderReceipt(request,unresolved,now).status,'unknown');
});

test('IOC local zero requires exact original client identity and no native id',()=>{
  for(const patch of [{clientOrderId:'different-original-id'},{id:'native-order-id'}])
    assert.equal(isProvenNoSubmitReceipt(request,veto(patch)),false);
  assert.equal(normalizeOrderReceipt(request,veto({clientOrderId:'different-original-id'}),now).status,'unknown');
});

test('IOC local zero rejects contradictory cash and invalid timestamp evidence',()=>{
  for(const patch of [{filledQuantity:1},{averagePrice:.03},{feeUsd:.001},{timestamp:0},{timestamp:NaN}]){
    const malformed=veto(patch);
    assert.equal(isProvenNoSubmitReceipt(request,malformed),false,JSON.stringify(patch));
    assert.equal(normalizeOrderReceipt(request,malformed,now).status,'unknown',JSON.stringify(patch));
  }
});

test('new local veto cannot clear an earlier unknown original even when its lower bound is zero',()=>{
  const prior=unknown();
  const normalized=normalizeOrderReceipt(request,veto(),now,prior);
  assert.equal(normalized.status,'unknown');
  assert.equal(normalized.id,prior.id);
  assert.equal(normalized.filledQuantity,prior.filledQuantity);
});

test('new local veto cannot erase unknown native identity or already observed fill cash',()=>{
  const prior=unknown({id:'original-native-order',filledQuantity:4,averagePrice:.031,feeUsd:.000062});
  const normalized=normalizeOrderReceipt(request,veto(),now,prior);
  assert.equal(normalized.status,'unknown');
  assert.equal(normalized.id,prior.id);
  assert.equal(normalized.filledQuantity,4);
  assert.equal(normalized.averagePrice,prior.averagePrice);
  assert.equal(normalized.feeUsd,prior.feeUsd);
});
