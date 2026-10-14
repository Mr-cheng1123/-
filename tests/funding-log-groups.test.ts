import test from 'node:test';
import assert from 'node:assert/strict';
import {groupFundingLogs} from '../web/src/funding-log-groups.js';
import type {LogEntry} from '../src/shared/types.js';

const warning=(id:string,timestamp:number,context?:string):LogEntry=>({id,timestamp,level:'warn',
  message:'bybit 资金费账单暂不可用，已保留待核对状态',...(context?{context}:{})});
test('old repeated funding warnings preserve every original ID and time in one chronological fold',()=>{
  const rows=Array.from({length:420},(_,index)=>warning(`old-${index}`,index)),before=structuredClone(rows);
  const groups=groupFundingLogs(rows);
  assert.equal(groups.length,1);assert.equal(groups[0].entries.length,420);assert.equal(groups[0].latest.id,'old-419');
  assert.equal(groups[0].entries.at(-1)?.id,'old-0');assert.deepEqual(rows,before);
  assert.deepEqual(new Set(groups[0].entries.map(entry=>entry.id)),new Set(rows.map(entry=>entry.id)));
});
test('recovery and financial events keep their chronology and split repeated warning blocks',()=>{
  const recovered:LogEntry={id:'recovery',timestamp:2,level:'info',message:'bybit 资金费账单已恢复'};
  const traded:LogEntry={id:'order',timestamp:5,level:'warn',message:'平仓结果待核对'};
  const groups=groupFundingLogs([warning('past',1),recovered,warning('new1',3),warning('new2',4),traded]);
  assert.deepEqual(groups.map(group=>group.latest.id),['order','new2','recovery','past']);
  assert.deepEqual(groups.map(group=>group.entries.length),[1,2,1,1]);
});
test('different context, reason, level and unrelated events cannot disappear into a funding warning',()=>{
  const rows=[warning('a',1,'cycle-a'),warning('b',2,'cycle-b'),{...warning('c',3),message:'bybit 资金费账单参数错误'},
    {...warning('d',4),level:'error' as const}, {id:'e',timestamp:5,level:'warn' as const,message:'其他故障'},
    {id:'f',timestamp:6,level:'warn' as const,message:'其他故障'}];
  assert.equal(groupFundingLogs(rows).length,rows.length);
});
test('new identical warnings and a bounded raw log tail keep the expanded fold key stable',()=>{
  const first=[warning('old1',1),warning('old2',2)];
  const key=groupFundingLogs(first)[0].key;
  assert.equal(groupFundingLogs([...first,warning('new',3)])[0].key,key);
  assert.equal(groupFundingLogs([warning('new',3)])[0].key,key);
  const boundary:LogEntry={id:'boundary',timestamp:0,level:'info',message:'其他事件'};
  assert.equal(groupFundingLogs([...first,boundary])[0].key,groupFundingLogs([...first,warning('new',3),boundary])[0].key);
});
