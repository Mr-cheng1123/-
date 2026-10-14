import {TLSSocket} from 'node:tls';

export interface ProxyConnectCancellationContext {signal?:AbortSignal}
type ContextReader=()=>ProxyConnectCancellationContext|undefined;
const readers=new WeakMap<object,ContextReader>();
const tlsDispatcherOwners=new WeakMap<object,object>();

/** This installed ProxyAgent's native TLS connector returns its newly created
 * socket before handing it to the origin pool. Only that undelivered socket
 * belongs to this handshake; a delivered/reused socket must outlive its caller. */
function cancelUndeliveredProxyTls(client:any,dispatcher:any):void {
  const ProxyAgent=client.undiciModule?.ProxyAgent;
  if(typeof ProxyAgent!=='function'||!(dispatcher instanceof ProxyAgent)||tlsDispatcherOwners.has(dispatcher))return;
  const keys=Object.getOwnPropertySymbols(dispatcher).filter(key=>key.description==='connect endpoint function');
  if(keys.length!==1)return;
  const key=keys[0],descriptor=Object.getOwnPropertyDescriptor(dispatcher,key);
  if(!descriptor||descriptor.writable!==true||typeof descriptor.value!=='function')return;
  const connect=descriptor.value;
  Object.defineProperty(dispatcher,key,{...descriptor,value:function(this:any,parameters:any,callback:any){
    const signal=readers.get(client)?.()?.signal;
    if(this!==dispatcher||parameters?.protocol!=='https:'||!parameters.httpSocket||!signal||typeof callback!=='function')
      return connect.call(this,parameters,callback);
    let delivered=false,socket:TLSSocket|undefined;
    const clean=()=>{signal.removeEventListener('abort',abort);socket?.removeListener('close',clean);};
    const abort=()=>{if(!delivered&&socket&&!socket.destroyed){
      const reason=signal.reason;socket.destroy(reason instanceof Error?reason:new Error('Proxy target TLS handshake cancelled'));
    }};
    const complete=function(this:any,...args:any[]){delivered=true;clean();return callback.apply(this,args);};
    // A synchronous native failure is preserved without fabricating a callback.
    const created=connect.call(this,parameters,complete);
    if(created instanceof TLSSocket&&!delivered){
      socket=created;socket.once('close',clean);signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    }
    return created;
  }});
  tlsDispatcherOwners.set(dispatcher,client);
}

/** Undici's origin connector omits the request signal before ProxyAgent starts
 * CONNECT. Forward the actual scoped signal into that native proxy handshake;
 * keep the original proxy pool, options, callbacks and cache ownership intact. */
export function installProxyConnectCancellation(client:any,currentContext:ContextReader):void {
  if(!client||typeof client.getDispatcherOptions!=='function')return;
  if(readers.has(client)){readers.set(client,currentContext);return;}
  readers.set(client,currentContext);
  const dispatcherOptions=client.getDispatcherOptions;
  const wrappedPools=new WeakSet<object>();
  if(typeof client.getFetchProxyDispatcher==='function'){
    const proxyDispatcher=client.getFetchProxyDispatcher;
    client.getFetchProxyDispatcher=function(...args:any[]){
      const dispatcher=proxyDispatcher.apply(this,args);
      if(this===client)cancelUndeliveredProxyTls(client,dispatcher);
      return dispatcher;
    };
  }
  client.getDispatcherOptions=function(isPlainAgent=false){
    const options=dispatcherOptions.call(this,isPlainAgent);
    if(this!==client||isPlainAgent||!options||typeof this.undiciModule?.Pool!=='function')return options;
    const existingFactory=options.clientFactory;
    return {...options,clientFactory:(origin:unknown,connectOptions:unknown)=>{
      // This is ProxyAgent's installed default (Pool), or the caller's exact
      // factory. Do not replace its dispatcher with a request-specific client.
      const proxyClient=typeof existingFactory==='function'?existingFactory(origin,connectOptions):
        new client.undiciModule.Pool(origin,connectOptions);
      if(!proxyClient||typeof proxyClient.connect!=='function'||wrappedPools.has(proxyClient))return proxyClient;
      wrappedPools.add(proxyClient);
      const connect=proxyClient.connect;
      proxyClient.connect=function(parameters:any,callback?:unknown){
        if(this!==proxyClient)return connect.call(this,parameters,callback);
        const signal=readers.get(client)?.()?.signal;
        if(!signal)return connect.call(this,parameters,callback);
        const merged=parameters?.signal&&parameters.signal!==signal?AbortSignal.any([parameters.signal,signal]):signal;
        return connect.call(this,{...parameters,signal:merged},callback);
      };
      return proxyClient;
    }};
  };
}
