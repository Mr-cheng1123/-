# 交易所适配说明

`createAdapters(config)` 返回五所 USDT 永续适配器。Gate 私有执行使用专用 `GatePrivate`，支持实际账户的 `single` / `dual` / `dual_plus` 模式。Bitget 先读取账户设置，再由 `bitget-account.ts` 明确选择 Classic v2 或 UTA v3；未知账户类型或权限失败不回落旧账户。新增交易所时实现 `ExchangeAdapter` 并增加合约单位、订单不确定状态和账单测试。

## 行情单位与时间

- 仅匹配启用的 USDT 线性永续合约，base 必须完全相同；不自动把 `1000PEPE`、包装币或其他映射当成同一资产。
- 盘口数量、订单数量、持仓数量统一成币数量。下单时再除以 `contractSize` 转成张数，并拒绝不符合数量步长的委托。
- OI 与成交额换算为 USDT 名义价值；USDT 计价数字在应用中按 USD 展示，未引入美元兑 USDT 脱锚定价。
- OKX `fundingTime` 是下一次实际结算；`nextFundingTime` 对应再下一周期。Bitget 使用当前费率接口的 `nextUpdate` 和 `fundingRateInterval`，接受 1/2/4/8 小时等实际周期。Binance 资金费周期调整表缓存 60 秒，成功取得该表后未列出的合约遵循交易所 8 小时默认周期；无法取得周期字段时核验最近已结算记录，不把不同周期直接相减。
- 缺少价格、盘口、OI 或有效结算时间时仅剔除对应币种，其他币种的成功结果继续返回。`getDiagnostics()` 分别报告币种不可用、行情字段失败和历史费率补充状态。
- 历史资金费率缓存 5 分钟并以最多 2 个后台任务补充，首轮实时报价不等待历史请求。历史尚不足时返回真实当前行情及诊断信息，策略层阻止基于不完整趋势数据开仓。
- 每个交易所最多并行处理 2 个币种，并保留 CCXT 速率限制。元数据只加载相关衍生品类别；Gate 限 USDT，Bitget 直接加载一个 USDT-FUTURES 合约列表，跳过无关现货币种及模拟合约。公共模式跳过私有交易所需的服务器时钟同步。
- 公共行情采用 REST 轮询；Bybit 从同一 ticker 读取费率、价格、OI 和结算时间，Bitget 从 ticker 读取价格及 OI，减少重复请求。大量币种仍会增加更新耗时，界面按观察时间过滤过期快照；尚未实现 WebSocket 增量盘口。

## 演示模式

DemoAdapter 生成可重复规则的合成行情，各所使用相同结算起点，结算间隔通过 `demoSettlementSec` 加速。高费率用于演示开仓、结算、平仓全流程，界面中 8 小时名义周期及 APR 不代表真实市场收益。它拒绝所有交易所下单方法，纸面撮合由执行引擎负责。

## 私有交易边界

- Bitget Classic 执行仍限定单币、单向、逐仓；UTA 支持 basic/isolated、单向及双向、无债务且权益非负。其他币余额不累加到 USDT 开仓预算。只读账户检查不修改杠杆或模式。
- Bitget 总览与执行账户读取分开。Classic 分列合约、逐仓额度和现货余额；UTA 分列可用 USDT、账户可用保证金及总权益。UTA 空仓 `list:null` 可识别，其他缺失/异常列表不当作空数据。完整口径见 [交易所文档](../../docs/exchanges.md)。
- UTA 双向订单以 side/posSide 表达四种开平方向，查单核验 tradeSide；单向使用 reduceOnly。新合约无设置时仅在执行准备确认无仓无挂单后显式初始化逐仓双侧杠杆，读回完整一致才继续。高级/Delta、债务和未知模式仍不支持。
- 私有接口仅接受 `mode=live`、`dataSource=public`，完整实盘解锁由服务端控制。
- 适配器从 `BINANCE_API_KEY` / `BINANCE_API_SECRET` 等环境变量读取密钥；OKX 和 Bitget 另需对应的 `*_PASSPHRASE`。本机页面可保存凭据到 `.env`，不回传密钥、不写入配置 JSON、日志或浏览器持久存储；保存与只读检查均不解锁交易。
- Gate 支持 `single` / `dual` / `dual_plus`，Bitget UTA 支持单双向；其余适配开仓前验证单向/净持仓模式。均不自动切换账户持仓模式。Binance、Bybit 须预先配置逐仓；OKX 委托使用 `tdMode=isolated`。有外部持仓拒绝新开仓。
- 两腿先完成只读账户与合约检查，全部通过后才进入 `prepare` 配置杠杆并读回核验双侧。Gate 的 `enable_credit` / `enable_dual_plus` 不代表实际账户持仓模式；`dual_plus` 逐仓显式传 `pos_margin_mode`，按目标数量定量减仓，不用 `auto_size` 全平。只读连接检查不执行杠杆写入。
- 委托全部为有价格边界的 IOC 限价单，买入价格向下量化、卖出价格向上量化，不扩大执行引擎给定的滑点上限。
- 客户端 ID 按交易所字符限制确定性转换。重复 ID 不重发；并发重复调用也只会发出一次。网络超时后按 ID 查单，Bybit 查询实时及历史订单，Gate 必要时查询有限历史。
- 撤单应答不等于已确认终态。订单无法核实时返回 `unknown`，由执行引擎冻结并等待人工对账。
- 优先读取实际订单/成交手续费，统一为 USDT。前四所费用缺失或使用未支持币种支付时采用配置费率估算，尚未实现事后自动更正。Bitget 要求完整 USDT 费用，缺失或非 USDT 折扣费用保留为 `unknown` 待核验。

## 资金费账单

资金费现金流统一为收入正、支出负。Bybit 的 `execFee` 是支出为正，因此显式反号。Gate 使用账单 `change`，Binance 使用 `income`，OKX 使用 `balChg` / `posBalChg`，Bitget 分别使用 Classic / UTA 带符号账单；UTA 处理六类资金费，逐仓非零 positionAmount 但 amount 为零时报告待核验。

账单固定查询结束时间，Binance 按 page、Gate 按 offset、OKX 按 billId、Bybit 按游标分页，Bybit 同时按最多 7 天切片。每次扫描最多 200 页，重复页面/游标、冲突账单或超限会报告失败，不返回不完整的成功结果。相同账单 ID 在适配器及应用层都去重。历史保留期仍受交易所限制（例如 OKX 归档账单近 3 个月）；这不是长期账单归档服务。

## 本环境验证

2026-09-30 无密钥公共行情测试确认，使用本机已有节点建立应用独立线路后，Binance、Bybit、OKX、Gate、Bitget 均成功返回全部 6 个配置币种（BTC/ETH/SOL/DOGE/XRP/AVAX）的真实标记价格、指数价格、费率、结算时间、盘口、OI 和成交额。第二轮每个币种均有 8 条历史资金费率，诊断列表为空；完整一轮分别约 1.68、1.39、5.23、1.10、1.12 秒。这是当次测量，不是后续网络时延承诺。OKX 使用官方 `openapi.okx.com` 接口域名。原代理出口对 Binance / Bybit 的地域拒绝已通过独立线路解决，未修改系统代理。

代理由 `EXCHANGE_PROXY_URL`、交易所专属 `*_PROXY_URL` 或已有 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量提供，仅配置本应用的请求。网络模块对读取请求执行有限重试，对限流和访问拒绝实行冷却，并向监控面板提供分类状态。具体优先级和配置以项目网络说明为准。

适配器自动化测试覆盖 Bitget 官方字段格式、合约步长、结算周期、历史后台补充、单币故障隔离，以及 Classic 账户检查、IOC 查询/撤单/未知状态和资金费分页。本机 Gate、Bitget 凭据已配置，Bitget 余额已完成真实账户只读验证。订单、杠杆准备及资金费账单等私有执行行为仍仅通过测试替身验证，五所真实下单均未验收，执行保持锁定。

本轮 Gate 真实只读检查确认当前模式为 `dual_plus`、无仓无挂单，`get_leverage` 可读取双侧杠杆。`GatePrivate` 的模式适配、准备与定量平仓代码仅经测试替身验证，真实杠杆写入及下单未验收；未修改账户持仓模式，不记录余额或密钥。

Bitget 账单按最多 30 天窗口、每页 100 条游标分页，仅接受近 90 天范围；全部切片合计最多 200 页。分页重复或超限会报告失败，不返回不完整成功结果。

主要依据：[CCXT 手册](https://docs.ccxt.com/docs/manual)、[Bybit 下单 API](https://bybit-exchange.github.io/docs/v5/order/create-order)、[Bybit 资金费现金流符号](https://www.bybit.com/en/learn/bybit-guide/what-bybit-funding-rate-fee)、[OKX 分页规则](https://www.okx.com/docs-v5/trick_en/)、[Gate 永续 API](https://www.gate.com/docs/developers/apiv4/en/futures/)、[Bitget 合约行情接口](https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market)、[Bitget 合约配置](https://www.bitget.com/api-doc/classic/contract/market/Get-All-Symbols-Contracts)。当前安装的 CCXT 各交易所实现也经过字段核对。
