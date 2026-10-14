/** Windows maintenance helper. The only target evaluation is process.emit('SIGTERM').
 * No credentials, heap, other evaluations or financial endpoints are read. A failure
 * never falls back to process.kill/Stop-Process. Call only after verifying the PID.
 * Node's undocumented activation method must be rechecked after a Node upgrade.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {isIP} from 'node:net';

const run=promisify(execFile);
const EXPRESSION="process.emit('SIGTERM')";
function exists(pid){
  try{process.kill(pid,0);return true;}
  catch(e){if(e?.code==='ESRCH')return false;throw new Error('Cannot verify target process state');}
}
const tcpStates=new Set(['LISTENING','ESTABLISHED','SYN_SENT','SYN_RECEIVED','SYN_RCVD','FIN_WAIT_1','FIN_WAIT_2',
  'CLOSE_WAIT','CLOSING','LAST_ACK','TIME_WAIT','DELETE_TCB','CLOSED','BOUND']);
function endpoint(value){
  const match=value.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  if(!match)throw new Error('Inspector TCP ownership response was invalid');
  const address=match[1]??match[2],port=Number(match[3]);
  if(!isIP(address)||!Number.isInteger(port)||port<0||port>65535)throw new Error('Inspector TCP ownership response was invalid');
  return {address,port};
}
/** Parse both IPv4 and IPv6; unsupported/malformed output is never evidence of an empty port. */
export function parseNativeTcpListeners(output,port){
  // Header labels are localized (and may be OEM encoded); five aligned columns ending in
  // PID identify the table. The TCP row addresses, state and PID use ASCII on Windows.
  const hasHeader=typeof output==='string'&&output.split(/\r?\n/).some(line=>{
    const fields=line.trim().split(/[ \t]{2,}/);
    return fields.length===5&&fields[4]==='PID'&&fields.slice(0,4).every(field=>field.length>0&&!/\d/.test(field));
  });
  if(!hasHeader)
    throw new Error('Inspector TCP ownership response was invalid');
  const rows=[];
  for(const line of output.split(/\r?\n/)){
    if(!/^\s*TCP(?:\s|$)/.test(line))continue;
    const fields=line.trim().split(/\s+/);
    if(fields.length!==5||!tcpStates.has(fields[3])||!/^\d+$/.test(fields[4]))throw new Error('Inspector TCP ownership response was invalid');
    const local=endpoint(fields[1]);endpoint(fields[2]);
    const pid=Number(fields[4]);
    if(!Number.isSafeInteger(pid)||pid<0||pid>0x7fffffff)throw new Error('Inspector TCP ownership response was invalid');
    if(fields[3]==='LISTENING'&&local.port===port)rows.push({LocalAddress:local.address,OwningProcess:pid});
  }
  return rows;
}
async function listeners(port){
  let out;
  // PowerShell's NetTCPIP/CIM initialization can itself consume the old five-second budget.
  // Native netstat reads the OS TCP table without starting PowerShell or loading a CIM provider.
  try{
    if(!process.env.SystemRoot)throw new Error();
    out=await run(join(process.env.SystemRoot,'System32','netstat.exe'),['-ano'],{windowsHide:true,timeout:5000,maxBuffer:1024*1024,encoding:'buffer'});
  }
  catch{throw new Error('Cannot verify the inspector TCP owner');}
  return parseNativeTcpListeners(out.stdout.toString('utf8'),port);
}
function assertOwner(rows,pid){
  if(rows.length!==1||rows[0].OwningProcess!==pid||rows[0].LocalAddress!=='127.0.0.1')
    throw new Error('Inspector must belong to the exact target PID and bind only to 127.0.0.1');
}
async function emitTermination(url){
  const socket=new WebSocket(url);
  let completed=false;
  try{return await new Promise((resolveAck,reject)=>{
    const timer=setTimeout(()=>reject(new Error('SIGTERM handler acknowledgement timed out')),4000);
    const fail=()=>{clearTimeout(timer);if(!completed)reject(new Error('Inspector connection failed before acknowledgement'));};
    socket.addEventListener('error',fail);socket.addEventListener('close',fail);
    socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:EXPRESSION,returnByValue:true,timeout:1000}})));
    socket.addEventListener('message',event=>{
      let response;try{response=JSON.parse(event.data);}catch{return;}
      if(response.id!==1)return;
      clearTimeout(timer);completed=true;
      if(response.error||response.result?.exceptionDetails||response.result?.result?.value!==true)
        reject(new Error('The target did not acknowledge its SIGTERM listener'));
      else resolveAck(true);
    });
  });}finally{
    // Node waits for attached debuggers at exit. Detach as soon as emit is acknowledged.
    socket.close();
  }
}
export async function gracefulStopNode(pid,{port=9229,timeoutMs=45000}={}){
  if(process.platform!=='win32')throw new Error('This helper is restricted to Windows');
  if(!Number.isSafeInteger(pid)||pid<=0||pid>0x7fffffff||pid===process.pid)throw new Error('An explicit different positive PID is required');
  if(!Number.isInteger(port)||port<1024||port>65535||!Number.isFinite(timeoutMs)||timeoutMs<1000||timeoutMs>120000)
    throw new Error('Invalid inspector port or shutdown deadline');
  if(typeof process._debugProcess!=='function')throw new Error('This Node runtime cannot activate the Windows inspector');
  if(!exists(pid))throw new Error('The target process is already absent');
  if((await listeners(port)).length)throw new Error('Inspector port is occupied; activation refused');
  // The Windows native method waits on its activation thread with INFINITE.
  // Bound it in a separate helper; a deadline can terminate that helper only.
  try{await run(process.execPath,['-e','process._debugProcess(Number(process.argv[1]))',String(pid)],{
    windowsHide:true,timeout:5000,maxBuffer:1024,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH}});}
  catch{throw new Error('Inspector activation failed or timed out; the target was not forcibly terminated');}
  const deadline=Date.now()+timeoutMs;
  let rows=[];
  while(Date.now()<deadline){
    if(!exists(pid))throw new Error('The target exited before the shutdown handshake');
    rows=await listeners(port);
    if(rows.length)break;
    await delay(100);
  }
  assertOwner(rows,pid);
  let targets;
  try{
    const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(3000),redirect:'error'});
    if(!response.ok)throw new Error();targets=await response.json();
  }catch{throw new Error('The local inspector target could not be verified');}
  if(!Array.isArray(targets)||targets.length!==1||targets[0].type!=='node')throw new Error('Expected exactly one Node inspector target');
  let url;try{url=new URL(targets[0].webSocketDebuggerUrl);}catch{throw new Error('The inspector target URL is invalid');}
  if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||Number(url.port)!==port||url.username||url.password||url.search||url.hash)
    throw new Error('The inspector URL must belong to the verified local listener');
  assertOwner(await listeners(port),pid);
  await emitTermination(url.href);
  while(Date.now()<deadline){
    if(!exists(pid))return {pid,requested:true,exited:true,at:Date.now()};
    await delay(100);
  }
  throw new Error('Graceful shutdown timed out; the process was not forcibly terminated');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  gracefulStopNode(Number(process.argv[2]),{port:process.argv[3]===undefined?9229:Number(process.argv[3])})
    .then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.message);process.exitCode=1;});
}
