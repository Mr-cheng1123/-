import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

export const TRADING_OPERATIONS_VERSION='operations-v1';
let cached:string|undefined;
/** Identify this process's source at startup, including uncommitted changes; never read configuration or credentials. */
export function runtimeSourceVersion():string {
  if(cached)return cached;
  const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),hash=createHash('sha256');
  try {
    const files:string[]=[];
    const walk=(directory:string)=>{for(const item of readdirSync(directory,{withFileTypes:true})){
      if(item.isDirectory())walk(join(directory,item.name));
      else if(item.isFile()&&/\.(ts|tsx|css|json|html)$/.test(item.name))files.push(join(directory,item.name));
    }};
    walk(join(root,'src'));walk(join(root,'web'));
    for(const file of files.sort()){hash.update(relative(root,file).replaceAll('\\','/'));hash.update('\0');hash.update(readFileSync(file));hash.update('\0');}
    cached=`${TRADING_OPERATIONS_VERSION}:${hash.digest('hex')}`;
  }catch{cached=`${TRADING_OPERATIONS_VERSION}:source-unavailable`;}
  return cached;
}
