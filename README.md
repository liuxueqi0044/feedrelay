# FeedRelay

按架构实现的 RSS／Atom → Telegram 推送产品首版。包含英文官网、管理控制台、Bot 接入、公开来源采集、规则、可靠投递、Stars 账单和部署配置。

## 本地体验

需要 Node.js 22.12+ 和 pnpm 10.32.1。在此目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:3000>，进入工作空间并选择 **Try the demo workspace**。随后：

1. 添加内置 sample feed。
2. 连接模拟私聊目标。
3. 创建检查间隔为 60 分钟的 route，等待 initializing 变为 active。
4. 点击 **Publish sample update**，几秒后查看 Delivery logs 的 sent 状态。
5. 尝试关键词过滤、暂停、恢复、预览、OPML 导入导出及有边界的历史补发。

演示模式使用持久化 JSON 存储和模拟 Telegram，仅监听本机地址。**演示投递不会发送到真实 Telegram，也不接受真实支付。** 不填写任何凭据即可运行；Ctrl+C 停止。生产模式采用 PostgreSQL、pg-boss 和真实 Bot API，代码调用同一组领域服务。

## 模块与目录

| 架构模块 | 实现位置 |
|---|---|
| M01 身份、会话与工作空间 | `apps/server/src/services/auth.ts`、`packages/core` |
| M02 Telegram 与授权 | `apps/server/src/infrastructure/telegram.ts`、FeedService、Processor Inbox |
| M03 安全采集 | `packages/sources` |
| M04 调度、Outbox、任务 | `apps/server/src/infrastructure/jobs.ts` |
| M05 条目与身份去重 | FeedService.ingest、items、itemAliases |
| M06 规则、基线与模板 | FeedService、Processor.releaseRoute |
| M07 投递与限速 | Processor.deliver、attempts、rateLimits |
| M08 账单与权益 | `packages/billing` |
| M09 官网与控制台 | `apps/web` |
| M10 运营、备份与恢复 | `deploy`、`docs`、迁移和恢复脚本 |

领域模块共用仓库，分别启动 api、control-worker、fetch-worker、delivery-worker。生产 fetch worker 的环境不包含 Bot token。API 和 workers 通过持久化业务记录协作；队列记录不是付款或投递的唯一事实来源。

PostgreSQL 使用 Drizzle 管理具名业务表；每表保留 `id`、`workspace_id`、`created_at` 和受约束的 JSONB 领域记录，并建立业务唯一键和到期索引。这是首版的存储实现选择，便于保留不同平台的字段；尚未做架构文档中的千源容量测试。事务使用 aggregate advisory locks、SERIALIZABLE 和有界冲突重试。

## 已实现的产品能力

- Telegram OIDC Code+PKCE 浏览器登录、Mini App HMAC 验证、自有会话、CSRF 和跨工作空间检查。
- 私聊启动验证；频道 owner／管理员及 Bot 发帖权限验证；一次性绑定；权限复查。
- RSS 2.0／Atom、受限 HTML feed 自动发现、条件请求、OPML；DNS 全结果校验、连接 IP 固定、逐跳重定向检查、XML／响应大小限制。
- 新规则先成功抓取再建立基线；源内 seq、身份别名和编辑版本；包含／排除关键词、受限变量模板。
- 每目标排队与原子限速；429 退避；冻结 payload；崩溃后 unknown 状态；最多一次自动未知补发，之后人工确认。
- Free／Starter 配额；逻辑投递预留和幂等计量；Stars 30 天订阅；多期回执、重复／乱序付款、退款先于付款、取消续费及交易对账。
- 删除工作空间立即阻止新任务；自动续费取消确认前保留 deleting 状态，失败继续重试。
- 数据库恢复时创建 recovery epoch，冻结受影响规则和投递，等待新快照与人工检查。

Free：3 来源、1 目标、最短 60 分钟、每 30 天 200 次逻辑投递。Starter：30 来源、3 目标、最短 5 分钟、每付费周期 5,000 次。默认 `BILLING_ENABLED=false`；`STARTER_STARS=300` 是可调整配置，不能视为已经验证的最终售价。

## 生产接入

先按 `.env.example` 准备生产配置：Bot token／数字 ID、BotFather OIDC Client ID 与 Secret、至少 32 字符 webhook secret、PostgreSQL URL、HTTPS 域名。将 BotFather 的登录回调设为 `https://你的域名/api/auth/telegram/callback`。

```powershell
pnpm db:migrate
pnpm bot:setup
```

这两条命令需要已有的生产环境配置；setup 会向配置的 Bot 注册 webhook、命令和 Mini App 菜单。容器生产部署及命令见 [部署说明](docs/deployment.md)。加密逻辑备份和隔离恢复工具见 [恢复说明](docs/recovery.md)。正式收费前设置真实服务条款和支持联系方式，并用 Telegram 测试环境验证付款、退款与取消；公共页面内置文本需要按实际运营主体补全。

## 验证命令

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm audit --registry=https://registry.npmjs.org
pnpm docker:smoke
docker build --file deploy/server.Dockerfile --tag feedrelay-server:recovery-drill .
node deploy/recovery-smoke.mjs --server-image feedrelay-server:recovery-drill
```

测试包含安全抓取、RSS／Atom、账单、领域流程、Fastify API、真实 PostgreSQL 和 pg-boss。PostgreSQL 测试启动仅监听本机的临时数据库，不连接生产数据库、不发送真实 Telegram 消息。最后三条命令需要本机 Linux Docker，使用独立资源验证真实生产镜像和合成数据恢复；不公开端口，结束后清理本次资源。CI 在 `.github/workflows/ci.yml` 和 `.github/workflows/docker-smoke.yml`。测试结果和外部接入边界见 [交付验证记录](docs/verification.md)。

## 首版边界

首版支持公开无凭据 feed、私聊与频道、单条文本和原文链接。私密来源、群、任意网页爬虫、AI 摘要和媒体相册属于后续扩展。

Telegram 无法与本地数据库组成一次发送事务：回执丢失时，自动补发可能重复。`unknown`／`needs_review` 的预留在该权益周期内继续占用，避免把可能已经送达的消息当成免费失败。详细日志可清理，业务去重与付款记录必须保留。

持续订阅占位避免重复购买。用户取消或首单预结账未完成后，首版再次开通需要运营核实原订阅；不自动删除占位以掩盖潜在平台扣款。对账缺少确切付费期间的交易进入 needs_review，不猜测到账权益。

服务只能取得 feed 当前保留的文章。上游已经删除的历史内容无法补回；可见性、实际送达、付款结算、HTTPS、备份和恢复时限都需要在真实部署环境验收。
