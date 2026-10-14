import type {LogEntry} from '../../src/shared/types';

export interface FundingLogGroup {key:string;latest:LogEntry;entries:LogEntry[]}
const signature=(entry:LogEntry)=>JSON.stringify([entry.level,entry.message,entry.context??null]);
const fundingWarning=(entry:LogEntry)=>entry.level==='warn'&&entry.message.includes('资金费账单');

/** View only: keep every original event and never merge across a recovery or other event. */
export function groupFundingLogs(entries:readonly LogEntry[]):FundingLogGroup[] {
  const sorted=[...entries].sort((a,b)=>b.timestamp-a.timestamp),groups:FundingLogGroup[]=[];
  for(const entry of sorted){
    const previous=groups.at(-1);
    if(previous&&fundingWarning(entry)&&fundingWarning(previous.latest)&&signature(entry)===signature(previous.latest))
      previous.entries.push(entry);
    else groups.push({key:entry.id,latest:entry,entries:[entry]});
  }
  for(let index=0;index<groups.length;index++){
    const group=groups[index];
    if(fundingWarning(group.latest))
      // Anchor to the next different event, so another identical warning does not close an expanded fold.
      group.key=`funding-warning:${signature(group.latest)}:after:${groups[index+1]?.latest.id??'tail'}`;
  }
  return groups;
}
