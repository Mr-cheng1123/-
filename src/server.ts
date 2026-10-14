import 'dotenv/config';
import express from 'express';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupConfig } from './shared/startup-config.js';
import { Store } from './core/store.js';
import {runtimeSourceVersion,TRADING_OPERATIONS_VERSION} from './core/runtime-source-version.js';
import { Engine, safeMessage, FUNDING_WATCH_LIMIT } from './core/engine.js';
import { acquireInstanceLock } from './core/instance-lock.js';
import { generateDemoHistory } from './core/backtest.js';
import {runBacktestTask} from './core/backtest-task.js';
import { z } from 'zod';
import { ExchangeFundingStatistics } from './data/exchange-funding-statistics.js';
import { CoinGlassFundingStatistics } from './data/coinglass.js';
import { FUNDING_RANGES, type FundingStatsDataset } from './shared/funding-statistics.js';
import { calculateFundingCandidates, fundingOpportunityCoverage, pairFundingCandidateDetails, type FundingOpportunitiesResponse } from './shared/funding-opportunities.js';
import { AccountConnections, credentialsSchema } from './core/account-connections.js';
import { EXCHANGES } from './shared/types.js';
import { LivePortfolioMonitor } from './core/live-portfolio.js';
import {EXECUTION_POLICY_VERSION} from './shared/execution-profile.js';
import {makerCloseComparisonReport} from './shared/maker-close-comparison.js';
import {consumeMaintenanceHandoff,restoreVerifiedMaintenanceHoldings,type MaintenanceHandoff} from './core/maintenance-handoff.js';
import {inspectLiveEnvironment,liveEligibleExchanges} from './core/live-readiness.js';
import {dashboardState} from './shared/dashboard-state.js';
import {encodeFundingOpportunitiesTransport} from './shared/funding-opportunity-transport.js';
import {opportunityExchangeScope,filterOpportunityPairs,scopedFundingDataset} from './shared/opportunity-exchange-scope.js';

import {LocalRequestRejected,manualCloseSchema,selectedReconcileSchema,selectedMakerCloseRepairSchema,selectedNativeExitRecoverySchema,selectedExternalExposureRecoverySchema,parsePositionCloseRequest,parseConfigPatch} from './server-input.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const configPath=process.env.CONFIG_PATH?path.resolve(process.env.CONFIG_PATH):path.join(root,'config.json');
const fromFile=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
const mode=process.env.TRADING_MODE==='live'?'live':'paper';
const stateDir=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(root,'data');
const statePath=path.join(stateDir,`${mode}-state.json`);
const saved=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')).config:{};
const config=startupConfig(fromFile,saved,mode,process.env.DATA_SOURCE);
let livePermissionGranted=mode==='live'&&process.env.ALLOW_LIVE_TRADING==='true'&&process.env.LIVE_TRADING_ACK==='I_UNDERSTAND_THE_RISKS';
mkdirSync(stateDir,{recursive:true});
const lockPath=path.join(stateDir,`${mode}.lock`);
const instanceLock=await acquireInstanceLock(lockPath);
const store=new Store(statePath,config);
let maintenanceHandoff:MaintenanceHandoff|undefined;
if(process.env.MAINTENANCE_HANDOFF_FILE){
  try{
    if(!livePermissionGranted)throw new Error('Existing execution permission is required for maintenance');
    maintenanceHandoff=consumeMaintenanceHandoff(process.env.MAINTENANCE_HANDOFF_FILE,store.data,config,root,
      liveEligibleExchanges(inspectLiveEnvironment(),config.exchanges).map(v=>v.exchange));
  }catch{livePermissionGranted=false;store.log('warn','维护交接证明无效，继承许可未启用；原持仓保留并等待只读账户核对');}
  delete process.env.MAINTENANCE_HANDOFF_FILE;
}
const exchangeStatistics=new ExchangeFundingStatistics(),coinglassStatistics=new CoinGlassFundingStatistics();
function currentFundingStatistics():FundingStatsDataset {
  const selected=store.data.config.fundingStatsSource;
  return selected==='coinglass'||selected==='auto'&&coinglassStatistics.configured?coinglassStatistics.get('current'):exchangeStatistics.get();
}
const engine=new Engine(store,livePermissionGranted,{fundingStatistics:currentFundingStatistics,
  ...(maintenanceHandoff?{maintenanceExchanges:maintenanceHandoff.venues}:{})}),app=express();
const accountConnections=new AccountConnections(path.join(root,'.env'),()=>engine.config);
const livePortfolio=new LivePortfolioMonitor(()=>engine.config,{onObservation:portfolio=>{
  engine.observeOperationPortfolio(portfolio);
  return engine.observeAccountClosures(portfolio);
}});
function connectedOpportunityExchanges(){
  return opportunityExchangeScope({config:engine.config,liveReadiness:engine.liveReadiness(),livePortfolio:livePortfolio.state()});
}
function fundingOpportunities():FundingOpportunitiesResponse {
  const connectedExchanges=connectedOpportunityExchanges(),scopedConfig={...engine.config,exchanges:connectedExchanges};
  const dataset=scopedFundingDataset(currentFundingStatistics(),connectedExchanges),now=Date.now();
  const candidates=calculateFundingCandidates(dataset,scopedConfig,now);
  const rows=pairFundingCandidateDetails(candidates,engine.currentOpportunities(),engine.snapshots,id=>engine.verificationFailure(id),now);
  return {source:dataset.source,status:dataset.status,message:dataset.message,receivedAt:dataset.receivedAt,maxAgeMs:dataset.maxAgeMs,computedAt:now,
    coinCount:new Set(candidates.map(c=>c.base)).size,pairCount:rows.length,verificationLimit:FUNDING_WATCH_LIMIT,rows,connectedExchanges,
    coverage:fundingOpportunityCoverage(dataset,scopedConfig,candidates,rows,now),autoVerification:engine.autoVerificationStatus()};
}
app.disable('x-powered-by');
app.use((req,res,next)=>{
  const host=req.headers.host??'';
  if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))return res.status(403).json({error:'仅允许本机访问'});
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if(req.method!=='GET'&&req.method!=='HEAD'){
    const origin=req.headers.origin;
    if(origin){try{const u=new URL(origin);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return res.status(403).json({error:'不允许跨站请求'});}catch{return res.status(403).json({error:'请求来源无效'});}}
    if(req.headers['x-requested-with']!=='funding-arb')return res.status(403).json({error:'缺少本机操作标识'});
  }
  next();
});
app.use(express.json({limit:'16mb'}));
const sourceVersion=runtimeSourceVersion();
app.get('/api/health',(_req,res)=>res.json({ok:true,app:'funding-arb',pid:process.pid,mode:config.mode,liveUnlocked:engine.liveUnlocked,sourceVersion,tradingOperationsVersion:TRADING_OPERATIONS_VERSION,executionPolicy:EXECUTION_POLICY_VERSION,entryModel:'aligned-v1',marketVerification:'automatic-v2',entryPolicy:engine.config.entryPolicy??'dual',positionSync:'account-observed-v1',automaticEntryPolicy:'dual-path-100-80-v1',automaticFundingConfirmation:'current-pair-no-wait-v2',currentExitManagement:'configured-common-policy-v1',websocketSendObservation:'handled-native-send-v1',entryExecutionMode:engine.config.entryExecutionMode??'ioc',profitExitExecutionMode:engine.config.profitExitExecutionMode??'maker',executionStatistics:'confirmed-v1'}));
app.get('/api/state',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const rawState={...engine.state(),...(engine.config.mode==='live'?{livePortfolio:livePortfolio.state()}:{})};
  const state={...rawState,opportunities:filterOpportunityPairs(rawState.opportunities,opportunityExchangeScope(rawState))};
  res.json(req.query.view==='dashboard'?dashboardState(state):state);
});
app.get('/api/portfolio',async(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await livePortfolio.refresh());});
app.get('/api/accounts',(_req,res)=>{
  res.setHeader('Cache-Control','no-store');res.json({exchanges:accountConnections.list(),executionUnlocked:engine.liveUnlocked});
});
app.put('/api/accounts/:exchange/credentials',async(req,res)=>{
  const exchange=z.enum(EXCHANGES).parse(req.params.exchange);
  const credentials=credentialsSchema.parse(req.body);
  if(engine.config.mode!=='live')throw new Error('请先进入实盘准备模式再配置账户');
  if((exchange==='okx'||exchange==='bitget')&&!credentials.passphrase)throw new Error('该交易所需要 Passphrase');
  const account=await engine.updateCredentials(()=>accountConnections.save(exchange,credentials),()=>{
    accountConnections.assertCanSave(exchange);
    if(accountConnections.list().some(account=>account.exchange===exchange&&(account.positionCount??0)>0))
      throw new Error(`${exchange} 已读取账户仍有持仓，请先核对后再更换该所凭据`);
  },exchange);
  livePortfolio.reset();void livePortfolio.refresh();res.setHeader('Cache-Control','no-store');res.json({account,executionUnlocked:engine.liveUnlocked});
});
app.post('/api/accounts/:exchange/check',async(req,res)=>{
  const exchange=z.enum(EXCHANGES).parse(req.params.exchange);
  if(engine.config.mode!=='live')throw new Error('请先进入实盘准备模式再检查账户连接');
  const account=await accountConnections.check(exchange);
  res.setHeader('Cache-Control','no-store');res.json({account,executionUnlocked:engine.liveUnlocked});
});
app.get('/api/funding-statistics',(req,res)=>{
  const selected=z.enum(['auto','exchanges','coinglass']).parse(req.query.source??engine.config.fundingStatsSource);
  const range=z.enum(FUNDING_RANGES).parse(req.query.range??'current');
  const source=selected==='auto'?(coinglassStatistics.configured?'coinglass':'exchanges'):selected;
  let dataset:FundingStatsDataset;
  if(source==='coinglass')dataset=coinglassStatistics.get(range);
  else if(range==='current')dataset=exchangeStatistics.get();
  else dataset={source:'exchanges',range,status:'unsupported',rows:[],receivedAt:0,lastAttemptAt:0,nextRefreshAt:0,maxAgeMs:60000,
    sourceUrl:'https://www.coinglass.com/zh/FundingRate',marginScope:'USDT 线性永续',
    message:'交易所全市场统计目前提供当前费率；累计统计需要 CoinGlass 官方历史数据，不能用当前费率推算。'};
  res.setHeader('Cache-Control','no-store');res.json({...scopedFundingDataset(dataset,connectedOpportunityExchanges()),coinglassConfigured:coinglassStatistics.configured});
});
app.get('/api/funding-opportunities',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const data=fundingOpportunities();
  res.json(req.query.format==='columns-v1'?encodeFundingOpportunitiesTransport(data):data);
});
app.post('/api/funding-opportunities/verify',async(req,res)=>{
  const id=z.string().min(1).max(150).parse(req.body.opportunityId);
  const opportunity=await engine.verifyFundingCandidate(id);
  res.json({opportunity,...(opportunity?{}:{reason:engine.verificationFailure(id)})});
});
app.get('/api/orders',(_req,res)=>res.json(store.data.orders));
app.get('/api/maker-close-comparisons',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(makerCloseComparisonReport(store.data.orders));});
app.post('/api/trading/preflight',async(_req,res)=>{
  res.setHeader('Cache-Control','no-store');res.json(await engine.tradingPreflight());
});
app.post('/api/trading/authorize',async(req,res)=>{
  const input=z.object({acknowledgement:z.literal('RECHECK_LIVE_AUTHORIZATION')}).strict().parse(req.body);
  res.setHeader('Cache-Control','no-store');res.json(await engine.authorizeLiveAccounts(input.acknowledgement));
});
app.post('/api/trading/start',async(req,res)=>{
  const input=z.object({acknowledgement:z.literal('START_LIVE_TRADING')}).strict().parse(req.body);
  res.setHeader('Cache-Control','no-store');res.json(await engine.startLive(input.acknowledgement));
});
app.post('/api/trading/recover',async(req,res)=>{
  const input=z.object({acknowledgement:z.literal('RESTORE_LIVE_MANAGEMENT')}).strict().parse(req.body);
  res.setHeader('Cache-Control','no-store');res.json(await engine.recoverLive(input.acknowledgement));
});
app.post('/api/trading/reconcile-selected',async(req,res)=>{
  const input=selectedReconcileSchema.parse(req.body);
  res.setHeader('Cache-Control','no-store');res.json(await engine.reconcileSelectedPositions(input));
});
app.post('/api/trading/repair-maker-close-tail',async(req,res)=>{
  const input=selectedMakerCloseRepairSchema.parse(req.body);
  res.setHeader('Cache-Control','no-store');res.json(await engine.repairSelectedMakerClose(input));
});
app.post('/api/trading/restore-native-exit-management',async(req,res)=>{
  const input=selectedNativeExitRecoverySchema.parse(req.body);
  res.setHeader('Cache-Control','no-store');res.json(await engine.restoreSelectedNativeExitManagement(input));
});
app.post('/api/trading/restore-external-exposure-management',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json(await engine.restoreSelectedExternalExposureManagement(selectedExternalExposureRecoverySchema.parse(req.body)));
});
app.post('/api/control',async(req,res)=>{await engine.control(z.enum(['startAuto','pause','kill','resume','reconcile']).parse(req.body.action));res.json({ok:true});});
const manualEntrySchema=z.object({opportunityId:z.string().min(1).max(150),operationId:z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),expiresAt:z.number().finite().positive(),acknowledgement:z.literal('OPEN_LIVE_HEDGE')}).strict();
app.post('/api/positions',(req,res)=>{
  if(!req.body?.operationId||req.body?.acknowledgement===undefined)return res.status(409).json({error:'页面版本已更新，请刷新后重新点击；未接收开仓请求'});
  const input=manualEntrySchema.parse(req.body);
  // A POST reply is a receipt, not a long-running order result. A lost reply is recovered by its same ID.
  const operation=engine.requestManualEntry(input.opportunityId,input.operationId,input.expiresAt,input.acknowledgement);
  res.on('close',()=>{if(!res.writableFinished)engine.cancelManualEntry(operation.id);});
  res.setHeader('Cache-Control','no-store');res.status(202).json({operation});
});
app.get('/api/entry-operations/:id',(req,res)=>{
  const operation=engine.manualEntryOperation(String(req.params.id),true);res.setHeader('Cache-Control','no-store');
  if(!operation)return res.status(404).json({error:'开仓请求尚未接收或操作标识不存在'});
  res.json({operation});
});
app.post('/api/entry-operations/:id/cancel',(req,res)=>{
  const operation=engine.cancelManualEntry(String(req.params.id));res.setHeader('Cache-Control','no-store');
  if(!operation)return res.status(404).json({error:'开仓操作不存在'});
  res.json({operation});
});
app.post('/api/positions/:id/close',async(req,res)=>res.json(await engine.close(String(req.params.id),parsePositionCloseRequest(engine.config.mode,req.body))));
app.post('/api/portfolio/close',async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await engine.closeAccountPosition(manualCloseSchema.parse(req.body)));});
app.patch('/api/config',async(req,res)=>{const {partial,expectedConfig}=parseConfigPatch(req.body);res.setHeader('Cache-Control','no-store');res.json(await engine.updateConfig(partial,expectedConfig));});
const rowSchema=z.object({timestamp:z.number().finite().positive(),exchange:z.enum(['binance','bybit','okx','gate','bitget']),base:z.string().regex(/^[A-Z0-9]{2,15}$/),markPrice:z.number().finite().positive(),fundingRate:z.number().finite().min(-1).max(1),nextFundingTime:z.number().finite().positive(),intervalHours:z.number().finite().positive().max(48),settledFundingRate:z.number().finite().min(-1).max(1).optional(),bidPrice:z.number().finite().positive().optional(),askPrice:z.number().finite().positive().optional(),priceTimestamp:z.number().finite().positive().optional(),volume24hUsd:z.number().finite().nonnegative().optional(),openInterestUsd:z.number().finite().nonnegative().optional()});
let backtestBusy=false;
app.post('/api/backtest',async(req,res)=>{
  if(backtestBusy)return res.status(409).json({error:'已有回测运行中，请稍后再试'});
  const demo=req.body.source==='demo';
  const rows=demo?generateDemoHistory():z.array(rowSchema).min(4).max(200000).parse(req.body.rows);
  backtestBusy=true;
  try{
    const result=await runBacktestTask(rows,engine.config,demo?'合成演示数据':'用户导入历史数据');
    res.json(result);
  }finally{backtestBusy=false;}
});
app.use(express.static(path.join(root,'dist')));
app.get('/',(_req,res)=>{if(existsSync(path.join(root,'dist','index.html')))res.sendFile(path.join(root,'dist','index.html'));else res.status(503).send('请先运行 npm run build，或使用 npm run dev 打开开发界面。');});
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(error instanceof LocalRequestRejected)return res.status(error.status).json({error:error.message});
  if(error instanceof Error&&(error as Error&{code?:unknown}).code==='CONFIG_CONFLICT')return res.status(409).json({error:safeMessage(error),code:'CONFIG_CONFLICT'});
  if(error instanceof z.ZodError)return res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；')});
  res.status(400).json({error:safeMessage(error)});
});
const port=Number(process.env.PORT??8787);
const server=app.listen(port,'127.0.0.1',()=>{
  console.log(`Funding Arb: http://127.0.0.1:${port} (${mode}/${config.dataSource})`);
  void (async()=>{
    if(maintenanceHandoff){try{await restoreVerifiedMaintenanceHoldings(engine,maintenanceHandoff);}catch{store.log('warn','维护后的账户核对未完成，原持仓记录完整保留；等待账户核对后继续管理');}}
    void engine.start();exchangeStatistics.start();if(mode==='live')livePortfolio.start();
  })();
});
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;server.close();await Promise.allSettled([engine.stop(),livePortfolio.stop(),exchangeStatistics.stop(),coinglassStatistics.stop()]);await instanceLock.release();process.exit(0);}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
// Node exits on an unhandled rejection by default, which would silently stop position management while orders
// may be open. Log a sanitized reason and keep serving; the reconcile/risk paths do not depend on that promise.
process.on('unhandledRejection',reason=>{console.error(`[${new Date().toISOString()} PID ${process.pid}] Unhandled rejection: ${safeMessage(reason)}`);});
server.on('error',error=>{console.error(error.message);instanceLock.releaseSync();process.exit(1);});
