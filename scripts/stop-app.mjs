import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,realpath} from 'node:fs/promises';
import {hostname} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {gracefulStopNode,parseNativeTcpListeners} from './graceful-stop-node.mjs';

const run=promisify(execFile);
const refuse=message=>{throw new Error(message);};
export function localAppUrl(value){
  let url;try{url=new URL(value);}catch{refuse('软件地址无效，未停止任何进程。');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    !Number.isInteger(Number(url.port))||Number(url.port)<1024||Number(url.port)>65535)refuse('只能关闭已核对的本机软件，未停止任何进程。');
  return url;
}

/** Stop authority is tied to the live instance, its native port owner and its saved lock. */
export function verifyStopIdentity({health,pid,lock,processInfo,listeners,nodePath,expectedToken,host=hostname()}){
  if(!Number.isSafeInteger(pid)||pid<=0||health?.ok!==true||health.app!=='funding-arb'||health.pid!==pid||!['live','paper'].includes(health.mode))
    refuse('后台身份已变化，请重新打开软件控制窗口。');
  if(lock?.version!==1||lock.app!=='funding-arb'||lock.pid!==pid||lock.hostname!==host||
    typeof lock.token!=='string'||!/^[0-9a-f-]{36}$/i.test(lock.token)||!Number.isFinite(lock.createdAt))
    refuse('软件实例锁与当前后台不一致，保留后台运行。');
  if(expectedToken!==undefined&&lock.token!==expectedToken)refuse('原后台已被替换，旧窗口不会关闭新实例。');
  const line=processInfo?.CommandLine??'',createdAt=processInfo?.createdAt;
  if(processInfo?.ProcessId!==pid||typeof processInfo.ExecutablePath!=='string'||processInfo.ExecutablePath.toLowerCase()!==nodePath.toLowerCase()||
    !/(?:^|\s)--import\s+(?:"tsx"|tsx)(?:\s|$)/.test(line)||!/(?:^|\s)"?src[\\/]server\.ts"?(?:\s|$)/.test(line)||
    !Number.isFinite(createdAt)||createdAt>lock.createdAt+2000||lock.createdAt-createdAt>120000)
    refuse('无法核对后台进程的程序和启动时间，保留后台运行。');
  if(listeners.length!==1||listeners[0].OwningProcess!==pid||listeners[0].LocalAddress!=='127.0.0.1')
    refuse('软件端口不属于原后台，未停止任何进程。');
  return {pid,mode:health.mode,token:lock.token,createdAt:lock.createdAt};
}

export async function inspectStopTarget({url,pid,project,token}){
  if(process.platform!=='win32')refuse('此关闭入口仅用于 Windows。');
  const address=localAppUrl(url),root=await realpath(resolve(project));
  let settings={};try{settings=dotenv.parse(await readFile(join(root,'.env')));}catch(error){if(error.code!=='ENOENT')throw error;}
  const dataDir=resolve(root,process.env.DATA_DIR??settings.DATA_DIR??'data');
  const healthResponse=await fetch(new URL('api/health',address),{signal:AbortSignal.timeout(2500),redirect:'error'});
  if(!healthResponse.ok)refuse('后台没有返回有效状态，保留后台运行。');
  const health=await healthResponse.json();
  if(!['live','paper'].includes(health.mode))refuse('后台运行模式无法确认。');
  const lockPath=join(dataDir,`${health.mode}.lock`),lock=JSON.parse(await readFile(lockPath,'utf8'));
  // The only interpolated value is a validated integer PID, never a path or shell text.
  if(!Number.isSafeInteger(pid)||pid<=0)refuse('后台进程编号无效。');
  const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){[ordered]@{ProcessId=$p.ProcessId;ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine;createdAt=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress}`;
  const [info,tcp]=await Promise.all([
    run(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-Command',script],{windowsHide:true,timeout:8000,maxBuffer:16384,encoding:'utf8'}),
    run(join(process.env.SystemRoot,'System32','netstat.exe'),['-ano'],{windowsHide:true,timeout:5000,maxBuffer:1024*1024,encoding:'buffer'}),
  ]);
  let processInfo;try{processInfo=JSON.parse(info.stdout.replace(/^\uFEFF/,''));}catch{refuse('后台进程已退出或无法核对。');}
  const identity=verifyStopIdentity({health,pid,lock,processInfo,listeners:parseNativeTcpListeners(tcp.stdout.toString('utf8'),Number(address.port)),nodePath:process.execPath,expectedToken:token});
  return {...identity,root,lockPath,url:address.href};
}

export async function stopApp(options){
  if(typeof options.token!=='string'||!/^[0-9a-f-]{36}$/i.test(options.token))refuse('缺少原软件实例确认，未停止任何后台。');
  const target=await inspectStopTarget(options);
  const latest=await inspectStopTarget(options);
  if(latest.token!==target.token||latest.createdAt!==target.createdAt)refuse('退出前后台已经换代，未停止替代进程。');
  // Recheck the exact lock nonce and HTTP owner immediately before sending SIGTERM.
  const [lock,response]=await Promise.all([
    readFile(target.lockPath,'utf8').then(JSON.parse),
    fetch(new URL('api/health',target.url),{signal:AbortSignal.timeout(2500),redirect:'error'}),
  ]);
  const health=await response.json();
  if(lock.token!==target.token||lock.pid!==target.pid||health.pid!==target.pid||health.app!=='funding-arb')
    refuse('退出前后台已变化，未停止替代进程。');
  const result=await gracefulStopNode(target.pid);
  // The helper waits for process exit; successful shutdown must also release this instance's lock.
  try{const remaining=JSON.parse(await readFile(target.lockPath,'utf8'));if(remaining.token===target.token)refuse('后台已退出，但实例锁尚未释放，请保留账本并检查日志。');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return {...result,app:'funding-arb'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const options={url:value('--url'),pid:Number(value('--pid')),project:value('--project'),token:value('--token')};
  (args.includes('--inspect-only')?inspectStopTarget(options):stopApp(options)).then(
    result=>console.log(JSON.stringify(result)),()=>{console.error('安全退出未完成：无法核对原后台或仍在等待在途处理；保留窗口与账本，请稍后重试。');process.exitCode=1;});
}
