# 跨交易所资金费率工作台

本地运行的跨交易所资金费率与价差观察、纸面模拟和交易执行软件。使用 TypeScript、React、Express 和 CCXT，支持 Binance、Bybit、OKX、Gate、Bitget。

此仓库包含源码、测试、启动脚本和空白配置模板。默认使用纸面账户，自动策略关闭；真实账户密钥、持仓账本、日志、代理节点配置和个人事故记录不在仓库中。测试内的历史订单身份是虚构示例，localhost TLS 测试证书仅用于本地回归测试。

## 安装与启动

需要 Node.js 22 或更新版本。

```powershell
git clone https://github.com/Mr-cheng1123/-.git funding-arb
cd funding-arb
npm ci
Copy-Item .env.example .env
Copy-Item config.example.json config.json
npm run build
npm start
```

打开 <http://127.0.0.1:8787>。Windows 也可双击 `start.cmd`，首次启动会安装依赖并构建页面；当前 Windows 启动器将缓存和临时文件放在 `D:\codex`。

`.env` 中的 `TRADING_MODE=paper` 保持纸面账户，`DATA_SOURCE=public` 使用公开行情。如果需要离线演示，可改成 `DATA_SOURCE=demo`。账户密钥在本机配置；模式、账户只读检查和实盘交易许可分别处理，重启后需重新完成本机许可流程。

应用只监听本机地址。生成的配置、账户资料和 `data/` 运行数据由 `.gitignore` 排除，分享副本时仍需检查未跟踪文件。

## 功能与执行规则

- 公开资金费统计、跨所机会、实时盘口、纸面账户和本地持仓账本。
- 自动入场保留两条判断路径及独立价格优势条件；候选估算不能代替下单前核验。
- 示例配置采用双腿对手价1限价 IOC，只减仓退出。盈利门槛是原开仓单腿固定本金的10bps：100U对应0.10U，分批后不缩小本金基准。
- 手续费按账户与合约在实际动作前核对；返佣比例在本机设置，只作为估算，不冒充到账资金。
- 原单状态未知时保留原身份并暂停相应动作；不以“查不到”当作零成交重发。
- 请求预算覆盖排队、共享市场加载、代理CONNECT、目标TLS和正文读取；原请求实际结束后才释放读取位置。未知原生实现保留原守卫。
- 首批、部分成交、补腿、尾差和持仓恢复均保留数量、身份、时效及账户核验。

行情、资金费及返佣收益属于对应阶段的估算，最终盈亏以真实成交和账单为准。网络失败仍会记录并阻止使用过期数据。

## 开发与验证

```powershell
npm test
node --import tsx --test tests/desktop-stop-identity.test.mjs tests/local-route-startup.test.mjs
npm run build
```

`npm run dev` 启动本地开发服务器。`npm run history` 提供公开历史行情下载入口。Windows专用的本机退出流程会核验进程、端口和实例锁，保留真实账本。
