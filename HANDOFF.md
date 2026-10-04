# FeedRelay 本机交付检查点

此文件替代旧的云端交接清单。当前开发与验收使用本仓库的本机代码，不依赖未发布的云端提交。

## 打开和运行

Node.js 22.12+、pnpm 10.32.1。安装后运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

官网：http://127.0.0.1:3000 。控制台：http://127.0.0.1:3000/dashboard 。没有凭据时选择 Try the demo workspace；添加内置来源、模拟私聊和推送规则，然后 Publish sample update。演示数据持久保存，重启后可继续体验。

## 代码与验证

模块、产品能力和首版边界见 README.md；架构见 docs/architecture.md；最终实测结果见 docs/verification.md。独立模块为 packages/core、packages/sources、packages/billing、apps/server 和 apps/web。

本机补齐了 PostgreSQL 事务锁与并发修复、代理后独立用户限流、390px 弹窗及表格布局、干净检出的 Next 类型生成，以及演示 OPML 导入导出。数据库事务保持 SERIALIZABLE，锁在同一连接的 BEGIN 前取得；连接池必须使用直连或 session pooling。

`pnpm docker:smoke` 构建实际生产镜像，在随机独立项目中验证迁移、API、网页与 pg-boss，使用假凭据和内部网络。恢复演练需先构建本机 server 镜像，再运行 `node deploy/recovery-smoke.mjs --server-image 镜像标签`，完整命令见 docs/recovery.md。两者不连接生产数据库，也不发送 Telegram 消息或执行付款。

## 真实接入

按 .env.example 和 docs/deployment.md 配置 Bot token、数字 Bot ID、OIDC、HTTPS 域名、数据库和 webhook secret，再执行迁移与 bot:setup。收费默认关闭；启用前配置实际运营条款与支持联系方式，并完成真实 Telegram 支付验收。

运行数据、凭据、备份私钥和本机诊断日志不得提交。备份与恢复流程见 docs/recovery.md。真实 Telegram/OIDC/Stars、HTTPS、异地加密备份和容量验收的状态以 docs/verification.md 为准。

私有仓库：https://github.com/liuxueqi0044/feedrelay 。
