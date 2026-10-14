import {Execution} from './execution.js';
import type {ExecutionContext} from './execution.js';
import type {SavedState,Store} from './store.js';
import {maintenanceHash,maintenanceLedgerHash} from './maintenance-handoff.js';
import {validateConfig} from '../shared/config.js';

/** Verify maintenance changed only previously unknown order observations and their
 * derived fills. New submissions, changed requests, or unrelated cash changes fail. */
export function verifyObservedLedger(before:SavedState,after:SavedState){
  const intents=(state:SavedState)=>state.orders.map(order=>({positionId:order.positionId,exchange:order.exchange,request:order.request,createdAt:order.createdAt}));
  const orderIntentsPreserved=maintenanceHash(intents(before))===maintenanceHash(intents(after));
  if(!orderIntentsPreserved||maintenanceHash(validateConfig(before.config))!==maintenanceHash(validateConfig(after.config)))return {recordsPreserved:false,orderIntentsPreserved,observedOrdersResolved:0};
  const expected=structuredClone(before),store={data:expected,save(){}} as Store;
  const execution=new Execution(store,{} as ExecutionContext);let observedOrdersResolved=0;
  try{
    for(let index=0;index<expected.orders.length;index++){
      const old=expected.orders[index],current=after.orders[index];
      if(maintenanceHash(old)===maintenanceHash(current))continue;
      if(!current.result||!execution.applyObservedOrder(old,current.result))throw new Error('Unrelated journal change');
      observedOrdersResolved++;
    }
    // Account archival and quote/status observations do not invent historical cash.
    const financial=(state:SavedState)=>maintenanceLedgerHash({...state,positions:state.positions.map(p=>({...p,accountClosure:undefined}))});
    return {recordsPreserved:financial(expected)===financial(after),orderIntentsPreserved,observedOrdersResolved};
  }catch{return {recordsPreserved:false,orderIntentsPreserved,observedOrdersResolved};}
}
