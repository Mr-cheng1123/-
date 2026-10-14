import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig, EquityPoint, ExchangeId, JournalOrder, LogEntry, OrderRequest, OrderResult, Position, SpreadObservation } from '../shared/types.js';
import type { ManualEntryOperation } from '../shared/manual-entry.js';
import {TradingOperationTracker} from './trading-operation-tracker.js';
/** Actual native replies whose original financial owner changed while the POST was pending.
 * Audit only: never replay or book these as another order automatically. */
export interface UnappliedRiskReceipt {positionId:string;exchange:ExchangeId;request:OrderRequest;result:OrderResult;observedAt:number;reason:'financial-owner-changed'}
export interface SavedState { version:1; config:AppConfig; positions:Position[]; orders:JournalOrder[]; logs:LogEntry[]; equity:EquityPoint[]; killSwitch:boolean; fundingSeen:string[];spreadObservations?:SpreadObservation[];manualEntryOperations?:ManualEntryOperation[];unappliedRiskReceipts?:UnappliedRiskReceipt[] }
export class Store {
  data:SavedState;
  readonly operations:TradingOperationTracker;
  constructor(readonly path:string,config:AppConfig){
    this.data={version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]};
    if(existsSync(path)){
      const parsed=JSON.parse(readFileSync(path,'utf8')) as SavedState;
      if(parsed.version!==1||!Array.isArray(parsed.positions)||!Array.isArray(parsed.orders))throw new Error('状态文件格式错误；保留原文件并检查，禁止自动覆盖');
      this.data={...parsed,config};
    }
    this.operations=new TradingOperationTracker(path);
  }
  save(){
    mkdirSync(dirname(this.path),{recursive:true});
    const temp=this.path+'.tmp',fd=openSync(temp,'w',0o600);
    try {writeFileSync(fd,JSON.stringify(this.data));fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,this.path);
  }
  log(level:LogEntry['level'],message:string,context?:string){
    // Only sanitized classifications should be passed, never exchange request payloads or credentials.
    this.data.logs.unshift({id:randomUUID(),timestamp:Date.now(),level,message,context});
    this.data.logs=this.data.logs.slice(0,500);this.save();
  }
}
