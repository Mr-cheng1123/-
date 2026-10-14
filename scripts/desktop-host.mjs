import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectStopTarget} from './stop-app.mjs';

export function parseDesktopHostArgs(args){
  const allowed=new Set(['--url','--pid','--project','--token','--ready-file']);
  const values=new Map();
  if(args.length!==10)throw new Error('任务栏窗口启动参数不完整。');
  for(let index=0;index<args.length;index+=2){
    const name=args[index],value=args[index+1];
    if(!allowed.has(name)||values.has(name)||typeof value!=='string'||!value.length)
      throw new Error('任务栏窗口启动参数无效。');
    values.set(name,value);
  }
  const pidText=values.get('--pid'),token=values.get('--token');
  if(!/^[1-9]\d*$/.test(pidText)||!Number.isSafeInteger(Number(pidText))||Number(pidText)>2147483647||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token))
    throw new Error('任务栏窗口的后台实例确认无效。');
  const project=values.get('--project'),readyFile=values.get('--ready-file');
  if(!isAbsolute(project)||!isAbsolute(readyFile)||!resolve(readyFile).toLowerCase().startsWith('d:\\codex\\'))
    throw new Error('任务栏窗口的就绪记录必须保存在 D:\\codex 下。');
  return {url:values.get('--url'),pid:Number(pidText),project:resolve(project),token,readyFile:resolve(readyFile)};
}

/** Detached Node keeps the normally spawned PowerShell GUI alive after the launcher exits.
 * This host only verifies the existing backend and displays the GUI; it never stops it.
 */
export async function runDesktopHost(options){
  const identity=await inspectStopTarget(options);
  const temporary='D:\\codex\\tmp\\funding-arb-desktop';
  await mkdir(temporary,{recursive:true});
  if(!process.env.SystemRoot)throw new Error('无法定位 Windows 窗口运行环境。');
  const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=['-STA','-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',join(identity.root,'scripts','desktop-window.ps1'),
    '-AppUrl',identity.url,'-ServerPid',String(identity.pid),'-InstanceToken',identity.token,'-NodePath',process.execPath,
    '-ProjectRoot',identity.root,'-ReadyFile',options.readyFile];
  const window=spawn(powershell,args,{
    cwd:identity.root,env:{...process.env,TEMP:temporary,TMP:temporary},windowsHide:true,
    // DETACHED_PROCESS prevents Windows PowerShell from executing -File at all.
    // Keep this child referenced; the launcher detaches the Node host instead.
    stdio:['ignore','inherit','inherit'],
  });
  console.log('desktop-host: gui-started');
  return await new Promise((resolveExit,reject)=>{
    window.once('error',reject);
    window.once('close',code=>resolveExit(Number.isInteger(code)?code:1));
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  Promise.resolve().then(()=>runDesktopHost(parseDesktopHostArgs(process.argv.slice(2)))).then(
    code=>{process.exitCode=code;},
    ()=>{console.error('任务栏窗口启动未完成，后台未被停止。');process.exitCode=1;},
  );
}
