import type {FundingOpportunitiesResponse} from './funding-opportunities.js';

type RecordValue=Record<string,unknown>;
interface Column {name:string;dictionary?:unknown[]}
export interface FundingOpportunitiesTransport {
  format:'funding-columns-v1';
  metadata:Omit<FundingOpportunitiesResponse,'rows'>;
  columns:Column[];
  /** Common fields in column order, optionally followed by an object of uncommon fields. */
  values:unknown[][];
}

const record=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:RecordValue,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const invalid=()=>new Error('机会数据格式无效，请刷新后重试');

/** A standalone snapshot, not a delta. A new reply replaces the previous rows:
 * disappeared pairs, direction changes, current fees and timestamps all survive.
 * JSON semantics match the full endpoint (NaN -> null, undefined fields omitted).
 * No price rounding, filtering, cache, trading decision or timeout is introduced. */
export function encodeFundingOpportunitiesTransport(data:FundingOpportunitiesResponse):FundingOpportunitiesTransport {
  const {rows,...metadata}=data;
  const records=rows as unknown as RecordValue[];
  const names=records.length?Object.keys(records[0]).filter(name=>records.every(row=>own(row,name)&&row[name]!==undefined)):[];
  const namesSet=new Set(names),columns:Column[]=names.map(name=>({name}));
  const values=records.map(row=>{
    const cells=names.map(name=>row[name]);
    let extras:RecordValue|undefined;
    for(const name of Object.keys(row))if(!namesSet.has(name)&&row[name]!==undefined){
      extras??={};assign(extras,name,row[name]);
    }
    if(extras)cells.push(extras);
    return cells;
  });
  // Dictionary selection is per column. High-cardinality values (ids/prices)
  // stay literal; repeated enums, funding clocks and reasons use short indices.
  for(let index=0;index<columns.length;index++){
    // Sampling only decides how to encode, never which rows/values to include.
    // Skip mostly-unique columns before allocating thousands of dictionary keys.
    const sampleCount=Math.min(128,values.length),sample=new Set<unknown>();
    for(let row=0;row<sampleCount;row++){
      const value=values[row][index];
      sample.add(value!==null&&typeof value==='object'?JSON.stringify(value):value);
    }
    if(sampleCount>=32&&sample.size>sampleCount/2)continue;
    const dictionary:unknown[]=[],indices:number[]=[],lengths:number[]=[];
    const primitives=new Map<unknown,number>(),objects=new Map<unknown,number>();
    let literalLength=0,indexLength=0,dictionaryLength=2;
    for(const row of values){
      const value=row[index];
      const isObject=value!==null&&typeof value==='object';
      // Native map keys avoid serializing each repeated primitive cell. Separate
      // maps prevent an object JSON string colliding with an actual string value.
      const key=isObject?JSON.stringify(value):value;
      const seen=isObject?objects:primitives;
      let entry=seen.get(key);
      if(entry===undefined){
        entry=dictionary.length;seen.set(key,entry);dictionary.push(value);
        const length=isObject?(key as string).length:JSON.stringify(value).length;
        lengths.push(length);dictionaryLength+=length+1;
      }
      indices.push(entry);literalLength+=lengths[entry]+1;indexLength+=String(entry).length+1;
    }
    if(dictionaryLength+indexLength+32<literalLength){
      columns[index].dictionary=dictionary;
      for(let row=0;row<values.length;row++)values[row][index]=indices[row];
    }
  }
  return {format:'funding-columns-v1',metadata,columns,values};
}

function assign(target:RecordValue,name:string,value:unknown){
  if(name==='__proto__')Object.defineProperty(target,name,{value,writable:true,enumerable:true,configurable:true});
  else target[name]=value;
}

/** Dictionaries are transport compression only. Independent decoded rows must
 * not acquire shared mutable reasons/checks through an interned object value. */
function cloneValue(value:unknown):unknown {
  if(Array.isArray(value))return value.map(cloneValue);
  if(record(value)){const result:RecordValue={};for(const [key,item] of Object.entries(value))assign(result,key,cloneValue(item));return result;}
  return value;
}

/** Accept the original response too, allowing the frontend to deploy before the
 * opt-in server route and preserving compatible older local servers. */
export function decodeFundingOpportunitiesTransport(input:unknown):FundingOpportunitiesResponse {
  if(!record(input))throw invalid();
  if(input.format===undefined){if(!Array.isArray(input.rows))throw invalid();return input as unknown as FundingOpportunitiesResponse;}
  if(input.format!=='funding-columns-v1'||!record(input.metadata)||own(input.metadata,'rows')||
    !Array.isArray(input.columns)||!Array.isArray(input.values))throw invalid();
  const columns:Column[]=[],names=new Set<string>();
  for(const value of input.columns){
    if(!record(value)||typeof value.name!=='string'||names.has(value.name)||
      own(value,'dictionary')&&!Array.isArray(value.dictionary))throw invalid();
    names.add(value.name);columns.push(value as unknown as Column);
  }
  // Establish all common properties up front. Incrementally growing thousands
  // of >20-property objects can put V8 into slow dictionary-property mode.
  const template=Object.fromEntries(columns.map(column=>[column.name,undefined]));
  const rows=input.values.map(cells=>{
    if(!Array.isArray(cells)||cells.length<columns.length||cells.length>columns.length+1)throw invalid();
    const row:RecordValue={...template};
    for(let index=0;index<columns.length;index++){
      const column=columns[index],value=cells[index];
      if(column.dictionary){
        if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>=column.dictionary.length)throw invalid();
        assign(row,column.name,cloneValue(column.dictionary[value]));
      }else assign(row,column.name,value);
    }
    if(cells.length>columns.length){
      const extras=cells[columns.length];if(!record(extras))throw invalid();
      for(const [name,value] of Object.entries(extras)){if(names.has(name))throw invalid();assign(row,name,value);}
    }
    return row;
  });
  return {...input.metadata,rows} as unknown as FundingOpportunitiesResponse;
}
