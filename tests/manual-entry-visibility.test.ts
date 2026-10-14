import assert from 'node:assert/strict';
import test from 'node:test';
import type {AppState} from '../src/shared/types.js';
import {createManualEntryRequest,manualEntryBlocksBase,type ManualEntryRequest} from '../web/src/manual-entry.js';
import {manualEntryGroups,MANUAL_ENTRY_HISTORY_PAGE_SIZE} from '../web/src/manual-entry-visibility.js';

const completed=(index:number)=>{
  const request=createManualEntryRequest(`COIN${index}-gate-bitget`,1_000_000+index,`entry-operation-${index}`);
  return {...request,sync:'connected' as const,operation:{id:request.id,opportunityId:request.opportunityId,state:'failed' as const,
    createdAt:request.requestedAt,updatedAt:request.requestedAt+1,expiresAt:request.expiresAt,leaseExpiresAt:request.expiresAt,
    ordersSubmitted:false,cancelable:false,message:'未提交'}};
};

test('large terminal history is paged without dropping any pending or unknown operation',()=>{
  const entries:ManualEntryRequest[]=Array.from({length:200},(_,index)=>completed(index));
  const pending=createManualEntryRequest('PENDING-gate-bitget',2_000_000,'pending-operation-1');
  const unknown={...completed(300),operation:{...completed(300).operation,ordersSubmitted:true,
    positionId:'unknown-position',result:{base:'COIN300',positionStatus:'attention',longQuantity:10,shortQuantity:0}}};
  const unconfirmed={...completed(301),operation:{...completed(301).operation,state:'completed' as const,ordersSubmitted:true,
    positionId:'unconfirmed-position',result:{base:'COIN301',positionStatus:'open',longQuantity:10,shortQuantity:10}}};
  const state={positions:[],unconfirmedOrders:[{positionId:'unconfirmed-position',historical:false}]} as unknown as AppState;
  entries.splice(20,0,unknown);entries.push(unconfirmed);
  const all=[...entries,pending];
  const groups=manualEntryGroups(all,state);
  assert.deepEqual(groups.attention.map(request=>request.id),[pending.id,unconfirmed.id,unknown.id]);
  assert.equal(groups.history.length,200);
  assert.equal(groups.history[0].id,'entry-operation-199');
  for(let page=0;page<Math.ceil(groups.history.length/MANUAL_ENTRY_HISTORY_PAGE_SIZE);page++){
    const visible=[...groups.attention,...groups.history.slice(page*MANUAL_ENTRY_HISTORY_PAGE_SIZE,(page+1)*MANUAL_ENTRY_HISTORY_PAGE_SIZE)];
    for(const request of groups.attention){assert.ok(visible.includes(request));assert.equal(manualEntryBlocksBase(request,state),true);}
  }
  assert.equal(all.length,203,'Paging does not delete persistent receipts.');
});

test('closed zero quantities with partial accounting remain visibly pending',()=>{
  const request=completed(10);
  Object.assign(request.operation,{ordersSubmitted:true,result:{base:request.base,positionStatus:'closed',longQuantity:0,shortQuantity:0,
    executionSummary:{accountingStatus:'partial',long:{exchange:'gate',openedQuantity:10,reducedQuantity:10,openingAttempts:1},
      short:{exchange:'bitget',openedQuantity:0,reducedQuantity:0,openingAttempts:1},events:[]}}});
  const groups=manualEntryGroups([request]);
  assert.equal(groups.attention[0],request);assert.equal(groups.history.length,0);
});
