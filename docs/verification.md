# 交付验证记录

检查日期：2026-10-04。以下均为本机或已确认的 GitHub 自动检查结果，未依赖云端 Codex 的未推送提交。

## 自动化与构建

| 项目 | 最终结果 |
| --- | --- |
| `pnpm test` | 7 个测试文件，154/154 通过 |
| `pnpm typecheck` | 全部 5 个工作空间包通过；Next 先生成类型再检查 |
| PostgreSQL integration | 13/13 通过，包含真实 pg-boss 及完整采集→规则→投递→配额链路 |
| 并发事务 | 两个独立连接池的 64 次同 key 写入全部成功，最终值64，callback64次 |
| 事务异常 | 回滚、部分授锁、授锁响应丢失、解锁失败、六次有界冲突重试均有覆盖 |
| Next.js 生产构建 | Windows 本机、Linux Docker 与 GitHub CI 通过 |
| 生产依赖审计 | 官方 npm 注册表返回无已知漏洞 |

正式存储保持 SERIALIZABLE。session advisory locks 在同一保留连接的 BEGIN 前取得，结束时反序释放；不确定的连接直接销毁，不重放已经提交的写入。生产数据库连接必须直连或使用 session pooling；不支持 transaction pooling。生产 Caddy 反代的客户端地址通过配置的可信 Docker 私网校验，用户不再共用反代地址的限流桶；直连默认不信任转发头。

## 浏览器实测

- 保留并继续体验已有演示工作空间；规则保存、消息预览、暂停和恢复正常。
- 发布 sample update4 后，日志为 Sent，1 次尝试；总计2次模拟送达，used2、reserved0。API 重启及网页重载后，来源、规则、送达记录和计量仍保留。
- OPML 预览、导入去重和浏览器真实文件下载通过。演示内置来源允许往返，生产 `.invalid` 地址和私网来源仍被拒绝。
- 控制台7个页面均在390px与1280px检查过，document scrollWidth不超过视口；手机端规则编辑、预览、恢复、送达详情及导入弹窗没有整页溢出。
- 官网、隐私和条款页面在390px检查通过；手机导入按钮保留可访问名称。

交付预览保存在仓库外的 `outputs/feedrelay-preview.jpg` 和 `outputs/feedrelay-mobile.jpg`。当前演示 API 监听127.0.0.1:4100，网页监听127.0.0.1:3000；重启命令见 README.md。

## 实际生产容器验收

`pnpm docker:smoke` 在 Docker Engine29.8.0 / Linux amd64 通过。项目 `feedrelay-smoke-20261004005801-372a190d79ff54b6` 的镜像实际构建、运行和清理均通过：

- PostgreSQL、三版迁移、API、web、fetch-worker 启动；五个 pg-boss 队列存在，真实 worker 完成无来源的安全 fetch 探针。
- 数据库 readiness、主页、同源 API rewrite、配置和 sitemap 正常。匿名请求401、生产 demo login404、无签名 webhook403。
- 应用使用UID1000，写入根文件系统实际得到EROFS。fetch worker没有Bot/OIDC凭据。
- 使用假凭据、内部网络和零公开端口；没有创建用户、消息投递、付款或被接受的 webhook 记录。
- 所有本次容器、网络、卷和带本次标签的镜像标记均已清理；只保留共享构建缓存。幂等 cleanup 命令复查通过。

实际本地镜像标识（未推送镜像到注册表）：

| 镜像 | ID |
| --- | --- |
| server | `sha256:e9ec0d7843c1e92e8ffd3b5c1fe2a2b9a3a007dd88864871ceb46406531f23e7` |
| web | `sha256:66b91f942637538c49134ad35ebcea1b95aca036d9158932fe09db6165bcbd39` |

本机详细证据在 `work/deploy-smoke/<上述项目>/results.json`、`commands.log`、`runtime.log`，不纳入源码或压缩包。Docker Desktop 的启动故障来自关机后遗留的 AF_UNIX 通信文件；本次仅备份并重建两个 socket-only 运行目录，没有重置 Docker、删除原有容器数据库或注销 WSL。

## 逻辑备份恢复

隔离合成数据库演练通过：31条业务记录、迁移1/2/3和内容摘要一致，13项数据库约束仍有效。sent 的唯一 ledger、unknown 的配额预留、付款/退款及精确期间权益均保留。custom-format归档70,631字节；单事务恢复0.478秒，全程含清理12.252秒。全部本次资源已清理。

这是小型合成数据的逻辑恢复验证。加密、异地传输、实际生产容量和 Telegram 对账仍需真实环境验收；不能把这些时间视为生产RTO承诺。完整实测记录及重复命令见 [恢复说明](recovery.md)。

## GitHub 自动检查

运行时代码提交 `d41ef97` 的两条流程已确认成功：

- [CI：类型、154项测试、生产构建、依赖审计](https://github.com/liuxueqi0044/feedrelay/actions/runs/37166866541)
- [Docker：实际生产镜像和隔离运行、清理](https://github.com/liuxueqi0044/feedrelay/actions/runs/37166866557)

后续提交的流程包含同一份逻辑恢复脚本，可在[仓库 Actions](https://github.com/liuxueqi0044/feedrelay/actions)查看最新结果。构建和演练日志保留为流程 artifact。

## 尚待真实配置的接入

演示及自动检查没有发送真实 Telegram 消息、创建真实订单、付款或启用收费。专用 Bot、OIDC、Stars 付款/退款/取消、公开 HTTPS、实际加密异地备份和容量指标需配置运营环境后验收。首版代码与部署工具已可运行；不把凭据未接入描述为已经公开上线。默认 `BILLING_ENABLED=false`。