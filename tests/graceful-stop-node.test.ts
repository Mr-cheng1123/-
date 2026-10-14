import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
// @ts-expect-error The maintenance helper is a standalone native JavaScript script.
import {gracefulStopNode,parseNativeTcpListeners} from '../scripts/graceful-stop-node.mjs';

async function port(){
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const value=address.port;await new Promise<void>(resolve=>server.close(()=>resolve()));return value;
}
function dummy(inspectorPort:number,code:string){
  // No .env, account modules or inherited API credentials are present in this child.
  return spawn(process.execPath,[`--inspect-port=127.0.0.1:${inspectorPort}`,'-e',code],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH}});
}

test('Windows inspector emits only SIGTERM and waits for the dummy queue to drain before exit',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const p=await port();
  const child=dummy(p,`
    let release;
    const queue=new Promise(resolve=>release=resolve);
    const interval=setInterval(()=>{},1000);
    process.stdin.once('data',()=>setTimeout(()=>{process.stdout.write('drained\\n');release();},350));
    process.on('SIGTERM',()=>{process.stdout.write('requested\\n');void queue.then(()=>{clearInterval(interval);process.exit(0);});});
    process.stdout.write('ready\\n');
  `);
  const exit=once(child,'exit');let output='';let requestedAt=0;
  const ready=new Promise<void>(resolve=>child.stdout.on('data',(value:Buffer)=>{
    output+=value.toString();if(output.includes('ready\n'))resolve();
    if(!requestedAt&&output.includes('requested\n')){requestedAt=Date.now();child.stdin.write('finish\n');}
  }));
  try{
    await ready;assert.ok(child.pid);
    const result=await gracefulStopNode(child.pid,{port:p,timeoutMs:20000});
    const [code,signal]=await exit;
    assert.equal(result.pid,child.pid);assert.equal(result.exited,true);
    assert.equal(code,0);assert.equal(signal,null);
    assert.ok(output.includes('requested\n'));assert.ok(output.includes('drained\n'));
    assert.ok(Date.now()-requestedAt>=300,'the pending async queue must finish before success');
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();}
});

test('Windows occupied inspector port cannot attach to or stop an unrelated process',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const child=dummy(address.port,`setInterval(()=>{},1000);process.stdout.write('ready\\n');`);
  try{
    await once(child.stdout,'data');assert.ok(child.pid);
    await assert.rejects(gracefulStopNode(child.pid,{port:address.port,timeoutMs:1000}),/occupied/);
    assert.equal(child.exitCode,null);assert.doesNotThrow(()=>process.kill(child.pid!,0));
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('invalid PID input is refused before inspector activation',{skip:process.platform!=='win32'},async()=>{
  for(const pid of [0,-1,NaN,1.5,process.pid])await assert.rejects(gracefulStopNode(pid),/positive PID/);
});

const tcpHeader='\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n';
test('native TCP ownership includes IPv4 and IPv6 listeners but excludes unrelated ports and established connections',()=>{
  const rows=parseNativeTcpListeners(tcpHeader+
    '  TCP  127.0.0.1:9229  0.0.0.0:0  LISTENING  1234\r\n'+
    '  TCP  [::]:9229  [::]:0  LISTENING  5678\r\n'+
    '  TCP  [::1]:9229  [::]:0  LISTENING  5679\r\n'+
    '  TCP  127.0.0.1:9230  0.0.0.0:0  LISTENING  7890\r\n'+
    '  TCP  127.0.0.1:9229  127.0.0.1:45000  ESTABLISHED  1234\r\n'+
    '  UDP  0.0.0.0:9229  *:*  9999\r\n',9229);
  assert.deepEqual(rows,[{LocalAddress:'127.0.0.1',OwningProcess:1234},{LocalAddress:'::',OwningProcess:5678},{LocalAddress:'::1',OwningProcess:5679}]);
});

test('localized or OEM encoded header text does not change ASCII TCP ownership fields',()=>{
  for(const header of ['  协议  本地地址          外部地址        状态           PID\r\n',
    '  Э��  ���ص�ַ          �ⲿ��ַ        ״̬           PID\r\n'])
    assert.deepEqual(parseNativeTcpListeners(header+'  TCP  127.0.0.1:9229  0.0.0.0:0  LISTENING  1234\r\n',9229),
      [{LocalAddress:'127.0.0.1',OwningProcess:1234}]);
});

test('malformed native output cannot masquerade as an empty inspector port',()=>{
  for(const output of ['', 'access denied',tcpHeader+'  TCP  127.0.0.1:9229  0.0.0.0:0  UNKNOWN  1234',
    tcpHeader+'  TCP  127.0.0.1:9229  0.0.0.0:0  LISTENING  missing',
    tcpHeader+'  TCP  999.0.0.1:9229  0.0.0.0:0  LISTENING  1234',
    tcpHeader+'  TCP  127.0.0.1:9229  malformed  LISTENING  1234',
    tcpHeader+'  TCP  127.0.0.1:9229  0.0.0.0:0  LISTENING  1234 extra'])
    assert.throws(()=>parseNativeTcpListeners(output,9229),/invalid/);
  assert.deepEqual(parseNativeTcpListeners(tcpHeader,9229),[]);
});
