# 债券贴现曲线自举与利率敏感度后端（教学演示）

单币种、无违约、固定现金流的贴现曲线自举、估值与 DV01 后端。**仅提供 JSON API、CLI、虚构报价与自动化测试**；不包含网页、期权定价，也不连接任何行情或交易服务。所有数字均为虚构教学数据。

## 技术栈与约定

- TypeScript + Node.js（内置实验模块 `node:sqlite`，无需原生编译），ESM。
- 时间口径全局统一：日期为 `YYYY-MM-DD`；计息惯例 `ACT/365F`，`t = 实际天数/365`。
- 零息利率与区间远期均为**连续复利**年化；单券到期收益率（YTM）是逐券 IRR，三者在报告中明确区分。
- 节点间对 `log(df)` 关于时间**线性插值**；`df(0)=1`；最后节点之外**拒绝外推**。
- 允许负利率，此时 `df > 1`，不强制贴现因子单调下降。

## 自举规则（严格）

1. 工具按到期日升序求解。
2. 每件工具的**早期支付必须恰好落在已解节点**上，否则报 `UNSUPPORTED_DATE_STRUCTURE`。
3. 每件工具的**最后一笔支付建立一个新节点**；最后一笔现金流必须为正，否则报 `NON_POSITIVE_FINAL_CASHFLOW`。
4. 全价 = 净价 + 应计利息；对每笔现金流折现之和必须重现输入全价，误差随报告保留。
5. 相同到期日的竞争报价报 `MATURITY_CONFLICT`，并在 `details.conflicting` 中列出全部报价，绝不悄悄二选一。
6. 解出非正因子报 `NON_POSITIVE_FACTOR`；没有任何工具报 `UNDERDETERMINED_CURVE`。
7. 报价修订创建**新版本与新曲线**；冻结报告保留原报价与误差，历史永不被覆盖。

DV01 采用零息曲线**平行平移**（默认 ±1bp），`df'(t)=df(t)e^{-h t}`，**现金流日期与金额固定不变**，价格变动只归因于利率。返回单边与中心差分两个口径，并记录扰动标签。

## 依赖安装

```powershell
node --version   # 需要 Node >= 22.5（开发于 v25）
npm install
```

## 运行测试

```powershell
npm test                 # node:test 自动化测试（内存库 + 文件库重启用例）
npm run typecheck        # 仅类型检查
npm run build            # 输出到 dist/
```

测试覆盖：平坦曲线两三节点手算核对、附息券自举、负利率（df>1 且上升）、非零应计、缺节点拒绝、同到期冲突报价、非正末笔/非正因子、欠定曲线、报价复现、插值连续、现金流线性、有限差分收敛、失败持久化、事务回滚、幂等重放、分页、重启后持久化与 HTTP 失败码。

## 可重复端到端演示

```powershell
npm run demo
```

使用项目内 `.tmp/demo.sqlite`（每次运行重建）：导入虚构工具与两套报价版本（基准与 +50bp 冲击）、构建两条曲线、打印零息/远期、对新债券估值并计算 DV01、比较版本、冻结报告。

## 启动 / 停止服务（只管理本项目进程）

```powershell
npm start
# 或后台：
npx tsx src/cli/index.ts serve          # 默认端口 0：系统自动分配，仅绑定 127.0.0.1
npx tsx src/cli/index.ts serve 8080     # 也可指定本机端口
npx tsx src/cli/index.ts stop           # 读取 .run/server.json，仅终止其中记录的 pid
```

启动后在 `.run/server.json` 写入 `{port,pid,dbPath}`；停止时只终止该 pid 并删除运行文件。数据库默认 `data/app.sqlite`，可用环境变量 `CURVE_DB_PATH` 覆盖；所有数据与临时文件均在本项目 `data/`、`.run/`、`.tmp/` 下。

## CLI 示例（含前后状态快照）

```powershell
npx tsx src/cli/index.ts seed-demo
npx tsx src/cli/index.ts list-versions
npx tsx src/cli/index.ts build-curve <quoteVersionId>
npx tsx src/cli/index.ts rates <curveId>
npx tsx src/cli/index.ts validate-payments 2026-09-30 CPN0003
npx tsx src/cli/index.ts value-bond <curveId> examples/new-bond.json demo-bond
npx tsx src/cli/index.ts compare <baseCurveId> <otherCurveId> 2027-09-30,2028-09-30
npx tsx src/cli/index.ts freeze-report <curveId>
npx tsx src/cli/index.ts show-report <curveId>
```

## HTTP API（节选）

- `GET  /api/health`
- `POST /api/instruments`（支持请求头 `Idempotency-Key`）
- `GET  /api/valuation-dates/{date}/instruments?limit=&offset=`
- `POST /api/quote-versions`（幂等）
- `GET  /api/quote-versions?limit=&offset=` / `GET /api/quote-versions/{id}`
- `POST /api/curves/build`（幂等；失败也持久化为 FAILED）
- `GET  /api/curves?limit=&offset=` / `GET /api/curves/{id}`
- `POST /api/valuations`（现值、连续复利 YTM、DV01；幂等）
- `POST /api/curves/compare`
- `POST /api/reports/freeze`（幂等）/ `GET /api/reports/by-curve/{curveId}`

错误响应统一为 `{ "error": { "code", "message", "details" } }`，错误码包括：
`VALIDATION_ERROR`、`PAYMENT_TIME_INVALID`、`UNSUPPORTED_DATE_STRUCTURE`、
`NON_POSITIVE_FINAL_CASHFLOW`、`NON_POSITIVE_FACTOR`、`MATURITY_CONFLICT`、
`UNDERDETERMINED_CURVE`、`EXTRAPOLATION_DENIED`、`NOT_FOUND`、`CONFLICT`。

## 目录

```
src/core/      日期、曲线插值、自举、定价、YTM、DV01（纯函数，易测）
src/db/        SQLite 连接、可重复迁移（schema_migrations）、事务/分页
src/services/  工具、报价版本、曲线、估值、冻结报告、幂等
src/api/       HTTP 服务（127.0.0.1，自动端口）
src/cli/       命令行（每次打印操作前后状态）
src/data/      虚构种子数据
examples/      导入用 JSON 夹具
test/          18 个自动化测试
```

清理：删除进程后，可直接删除 `data/`、`.tmp/`、`dist/`；停止命令只操作 `.run/server.json` 记录的本项目 pid。
