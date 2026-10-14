import {spawn} from 'node:child_process';
import {mkdir,readFile,unlink,appendFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {join,resolve} from 'node:path';
import {inspectStopTarget} from './stop-app.mjs';

export async function openDesktopWindow({url,pid,project}){
  if(process.platform!=='win32')return;
  const identity=await inspectStopTarget({url,pid,project});
  const temporary='D:\\codex\\tmp\\funding-arb-desktop';
  await mkdir(temporary,{recursive:true});
  const logs='D:\\codex\\logs\\funding-arb-desktop';await mkdir(logs,{recursive:true});
  const readyFile=join(temporary,'ready-'+randomUUID()+'.json');
  const log=openSync(join(logs,'window.log'),'a');let child;
  try{
    // Node survives a detached launch; its referenced GUI child keeps this small host alive.
    // PowerShell itself must be launched normally or it exits before -File executes.
    child=spawn(process.execPath,[resolve(project,'scripts/desktop-host.mjs'),'--url',url,'--pid',String(pid),
      '--token',identity.token,'--project',resolve(project),'--ready-file',readyFile],
      {cwd:project,env:{...process.env,TEMP:temporary,TMP:temporary},detached:true,windowsHide:true,stdio:['ignore',log,log]});
  }finally{closeSync(log);}
  let launchError;child.on('error',error=>{launchError=error.code??'SPAWN_FAILED';});
  try{
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      let receipt;try{receipt=JSON.parse(await readFile(readyFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(receipt?.ready===true&&receipt.serverPid===pid){return receipt;}
      if(launchError||child.exitCode!==null||child.signalCode!==null)break;
      await delay(100);
    }
    await appendFile(join(logs,'window.log'),JSON.stringify({at:Date.now(),phase:'window-launch-failed',windowPid:child.pid,launchError,exitCode:child.exitCode,signal:child.signalCode})+'\n');
    throw new Error('软件后台正在运行，但任务栏窗口未能显示。请查看 D:\\codex\\logs\\funding-arb-desktop\\window.log 后重新运行 start.cmd。');
  }finally{child.unref();try{await unlink(readyFile);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
