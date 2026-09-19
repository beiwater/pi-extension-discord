# 2026-09-19 双 bot 运行与上下文审查

初次审查记录与方案，R2–R5 的缺陷描述针对下述代码基线，不代表修复后的当前实现。对象为生产部署的 A「小雪」、B「小雨」。时间均为 Asia/Singapore（UTC+8）。后续获授权的 OOM 追查与 Cursor 下线结果补充在 R1；修复后的实际契约见 architecture/cache/testing。

代码基线：`47e1e7d`。远端 `main` 已包含 `deploy-20260916` 的所有提交，本地 `main` 已快进同步，工作分支无需另造 merge commit。初次审查只进行只读诊断、离线复现和验证，未重启服务、修改配置或数据库、调用真实 provider / Telegram。

证据来自 systemd / kernel journal、结构化 `daemon.log`、readonly SQLite、session JSONL 元数据，以及本地锁定的 Pi 0.84.1 实现。未将群正文、persona、模型原文或凭证复制进本报告。9 月 16 日整改前的配额故障与本轮新问题分开统计。

## 结论与优先级

| 编号 | 优先级 | 已确认事实 | 影响 |
| --- | --- | --- | --- |
| R1 | P0 | OOM 同时杀掉 daemon 和用户级 systemd，后者没有自动恢复 | 两 bot 停机约 53 小时 |
| R2 | P1 | 图片预算修正位于 Pi 的提前返回之后，部分超阈值上下文根本进不到修正逻辑 | 上下文超过配置窗口，新消息预算长期只有 512 tokens |
| R3 | P1 | direct-address 的成功条件是 provider 未报错，而不是产生公开发送 | 明确回复也可能被沉默消费，并被标成已完成 |
| R4 | P1 | context 模式的压缩请求只有文字，丢弃图片未进入摘要模型 | 未被聊天文字描述的视觉信息无法进入摘要 |
| R5 | P2 | skipped/coalesced trigger 可覆盖在途 run 的触发 ID；debug 还遗漏图片结构并混入摘要调用元数据 | 诊断产生“路由后未运行”等误导线索 |

另有一项已实现且有测试锁定的策略：普通消息超预算后允许被游标消费但不进上下文。本次长期停机后的批量回补放大了该策略的记忆缺口；这不是新发现的静默数据删除，原始数据库记录仍在。

## R1：停机与自动恢复失效

证据：

- `telegram-agent.service` journal：2026-09-17 12:19:38，`Failed with result 'oom-kill'`；下一次启动是 2026-09-19 17:19:34。
- kernel journal：同一分钟出现全机 `global_oom`，除了 daemon，还杀掉了 `user@1000.service` 的 systemd 进程。
- `user@1000.service` 的 `Restart=no`。bot 自身虽然配置 `Restart=on-failure`，监督它的用户级 manager 已退出，无法执行重启。`Linger=yes` 已开启，不能靠再开 linger 解决本次故障。
- bot unit 声明 `OOMScoreAdjust=-200`，但审查时 `/proc/193376/oom_score_adj` 实际为 `100`，配置值不能当作生效证明。

后续获授权的系统追查明确了主要资源来源：

- 宿主机物理内存约 7.7 GiB、swap 2 GiB。9 月 17 日现场是 `CONSTRAINT_NONE/global_oom`，不是 bot 的 cgroup 配额；匿名页约 6.72 GiB，swap 剩余 0。
- OOM 任务快照中有 113 个 `MainThread`，合计 RSS 约 6,688 MiB、swap 约 1,619 MiB。`cursor-api-proxy.service` 的 systemd 退出记录单独确认该服务峰值为 **6.8 GiB memory / 1.7 GiB swap**，且无内存或并发上限。代理的每请求 spawn 路径没有并发闸门。
- bot 在 OOM 时 RSS 约 160 MiB、swap 约 173 MiB，是连带受害者。当前 bot unit 的约 1 GiB `MemoryCurrent` 大部分是可回收文件页，不能当成约 1 GiB JS heap；Bun 的巨大虚拟地址空间也不是实际 RAM 占用。
- 保留的 kernel journal 只证实 9 月 17 日这一轮连锁 OOM 的 6 次 kill，不能据此声称发生了 6 次独立事故；systemd-oomd 未运行。现在有大量可用内存不反驳事故当时真实耗尽。

按用户后续明确指令，已停用 Cursor 代理及启动项，用 `paru` 卸载 `cursor-cli`，把旧版手动安装及 PATH 入口移入私有归档。LiteLLM 删除 204 个 Cursor model deployment 配置与 owner-all 的对应授权，同时移除生成脚本入口和专用定价项；其他 120 个模型配置经前后校验一致。重启后注册列表为 120、Cursor 为 0，health 正常；历史用量账单保留。配置与旧安装留有可恢复备份。

待审核方案：将这一部署迁到系统级 systemd service，继续以原业务用户运行、使用相同 checkout / data / Pi 配置，由系统级 manager 监督。切换时停用旧用户级 unit，确保只有一个轮询实例；保留原配置以便回退。启动前校验目录权限，启动后验证真实 OOM score、PID 归属、socket 与两 bot 状态。此项涉及主机服务配置与一次受控切换，需要系统级管理权限。

## R2：图片多、文字少时压缩准备提前退出

当前图片修正入口在 [runtime.handleBeforeCompact](../../src/agent/runtime.ts) 内的 `imageAwareCompactionCut()`，由 `session_before_compact` 触发。

Pi 0.84.1 的调用顺序是：`prepareCompaction()` → 有 preparation 才发 `session_before_compact`。前者按原始 custom message 的文字估算，图片在 `details.blocks` 中不参与估算。当全文都落在 `keepRecentTokens=20,000` 内时，没有待摘要消息，Pi 直接返回 `undefined`，本项目的图片修正没有执行机会。手动 `compact()` 也经过同一个准备步骤。

只读回放 9 月 16 日部署之后的真实 session 前缀：

- A：66 次高于 114,688 阈值的成功 assistant 调用中，60 次 Pi preparation 为空。
- B：63 次中有 59 次为空。
- A 在 9 月 17 日 10:53:19 的真实 usage 为 154,635 tokens，活跃上下文有 60 张图片，但 Pi 的文本估算约 19,911，仍无法准备压缩。
- B 在 9 月 17 日 12:19:13 的真实 usage 为 134,703 tokens、65 张图片，超过配置窗口 131,072，Pi 文本估算约 19,669，仍无法准备压缩。
- B 此前多轮 `context_packed.suffix_budget=512`；今天恢复后也延续到 17:22:57 才成功压缩。

待审核方案：在 Pi 计算 preparation **之前**，将配置的真实保留预算按文字与图片换算成 Pi 可理解的文本预算。复用公开的 `findCutPoint`、`SettingsManager.applyOverrides` 与 `session.compact()`；临时预算在成功、失败、取消后恢复，不固定改成 1 token，也不修改 node_modules。新消息打包前如空间不足，先完成这次有界压缩再计算 suffix 预算。保留窗口、摘要输入、visibility 与共享图片回收继续使用同一个切点。

验收必须使用真实 Pi AgentSession 与假的 provider：仅靠现有 fake session 的 `compact` 回调，无法覆盖 Pi 在 extension 之前的提前返回。覆盖图片多而文字不足 20k、阈值触发、手动压缩、取消、失败，以及压缩后新消息和图片确实进入下一请求。

## R3：明确回复也会因模型沉默而被清账

9 月 16 日 23:43:47，A 对消息 `#134119` 的链路为：

1. `routing_claims`：`reason=reply`、`status=started`。
2. session 的 assistant 正常 `stop`，持久化为 `[no_send]`，该 turn 没有任何 `send` toolResult。
3. 紧接着出现 `telegram_context_commit`，将 `134119` 写入 `deliveredObligationIds`，回复待办被删除。

[runtime.flush](../../src/agent/runtime.ts) 目前仅以 `lastTurnFailed` 决定是否清除 obligation。它保护了 provider 错误，却没有落实 [群聊协议](../../src/agent/prompt.ts) 中“明确 @、回复或点名必须回应”的承诺。

待审核方案：区分“模型读到消息”和“已完成公开发送”。明确寻址且零 send 的 turn 保留待办，并记录独立的未回应结果；最多追加一次有界补答机会，仍无结果则结束当前 flush，避免 `replyObligationCount > 0` 导致无限循环。公开发送已提交，或已到 `partial/unknown/no_retry` 边界时均禁止自动重复发送，未知结果单独标识。

验收：正常 send 清理待办；模型沉默、只有 search、provider error 不伪装成回复成功；补答次数有上限；unknown outcome 不重复发送；重启后状态可解释。正常 turn 不增加 LLM 调用，零 send 的明确寻址最多多一次调用。

## R4：压缩摘要看不到即将丢弃的图片

[generateCompactionSummary](../../src/agent/runtime.ts) 调用 `serializeCompactionMessages()` 后，把一整个字符串作为摘要请求的 user content。[compaction serializer](../../src/agent/extensions/compaction.ts) 只做 Pi 的文字序列化，没有经过聊天请求的图片投影。

离线复现：两个文本完全相同、图片引用不同的合法 Telegram custom message，在主聊天投影中有图片块，但生成的摘要输入完全相同。

今天两次真实压缩：A 图片引用从 50 个减至 15 个，B 从 65 个减至 13 个，而摘要请求仍只有文字。若某张图的内容已由聊天中的文字描述，摘要可以保留那些文字；没有文字描述的视觉细节则没有被交给摘要模型。

待审核方案：在现有一次摘要调用中携带待丢弃图片及所属消息 ID，保留时间和消息的对应关系，按摘要模型能力、窗口与字节预算设界；成功提交摘要后才进入既有回收流程。图片缺失或模型不支持图片时产生明确退化结果。复用已有图片文件与投影能力，不为每张图另开描述调用。

成本：主聊天每 turn 无额外调用；发生压缩时增加实际传入图片的输入 token。按项目当前 1,100 token/图片的规划估值，这次 A/B 分别有 35/52 个被移出上下文的图片引用，若逐个全部发送约增加 38.5k/57.2k 摘要输入 tokens；实际计费取决于 provider，重复图片可在保留消息关联的前提下复用。实现时必须验证预算和总费用，不能把所有旧图片无界塞回请求。

## R5：诊断关联与上下文展示有误

### 在途触发 ID 被跳过的消息覆盖

[BotRuntime.trigger](../../src/agent/runtime.ts) 在检查 busy/cooldown 前赋值 `currentTriggerMessageId`；打包结束又把它改成最后一个入选事件的 message ID。

离线复现：正在执行的 trigger 为 `100`，概率消息 `101` 返回 `skipped_busy`，但在途 ID 已变成 `101`。今天的实际记录中，A 的 `#141826` 启动后，run 被记到后来的 `#141827`；`debug` 随后将 `141826` 报成 `route_without_run`。

待审核方案：固定当前 run 的起因，待处理 trigger 单独持有，跳过的 trigger 不修改在途身份；事件批次范围继续用已有 event refs 表达。报告关联查询应独立按目标 claim 查找匹配 run，不能仅依赖最近 20 条 run 样本。

### debug 的图片与模型元数据不完整

[inspectProviderContext](../../src/observability/provider-context.ts) 未给 `projectTelegramContext` 传图片 resolver，输出中只有文字；`lastRun` 查询又没有排除 `compaction=1`。刚压缩后可能显示摘要调用的空 tools hash，却同时列出主聊天工具。

待审核方案：提供图片数量、类型和可用性等脱敏结构信息；主聊天元数据排除摘要调用。真实 base64 不进入默认报告。对 provider 失败和主动沉默补足固定类别，使“没有 run 行”可以区分失败与未启动。

此组修复只调整可观察性，Cache impact NONE，新增 LLM 调用和 token 均为 0。

## 恢复积压造成的上下文缺口：需要明确的策略

今天回补阶段的日志与 session event refs 对照：

| Bot | 被推进游标的事件区间 | DB 事件数 | 进入 session | 未进入 session |
| --- | --- | --- | --- | --- |
| A | `(3011896, 3015308]` | 3,412 | 78 | 3,334 |
| B | `(3011894, 3015287]` | 3,393 | 7 | 3,386 |

这里统计的是 immutable events，包含消息和 metadata，不能直接称为等量群消息。未进入 session 的 `kind=message` 事件分别为 3,248 和 3,299 条；其中也包含 bot 发言。

原因是最多扫描最近 256 条、按预算选择，然后把游标推进到整个 high-water；B 的 512-token 预算进一步缩小了选择范围。该行为已在 [测试策略](../testing.md) 与 `ordinary overflow is silently consumed` 测试中明确锁定，不能作为修复顺手改成无限回放。

建议默认仍采用有界近期窗口：修复 R2 后，恢复时先完成积压拉取再对新消息提供回复机会，保留全部 direct-address obligation 的保证；记录跳过数量和时间范围，并以追加事件明确告诉模型历史存在缺口。需要补齐较早记忆时，再从仍在 DB 的历史做有界摘要恢复。这一额外恢复任务应单独限定时间范围和 token 预算，不能承诺仅重启就恢复完整记忆。

## 实施顺序、cache 与验证

建议审核后按以下顺序实施，每个行为变化独立提交：

1. R1 的服务监督迁移，验证进程退出后能被系统级 manager 恢复。
2. R2 的压缩准备与打包预算修复，先用真实 Pi + fake provider 回归。
3. R3 的明确回应完成条件与补答上限。
4. R4 的视觉摘要输入，再处理恢复阶段的历史缺口标识。
5. R5 的诊断关联与脱敏结构显示。

R2 优先修 Pi 集成时序；R3 的补答 suffix、R4 的摘要输入以及历史缺口事件涉及 provider-visible 协议。实施时统一核对 cache impact，必要变化必须 bump `CACHE_SCHEMA_VERSION`、更新 cache golden 和 [docs/cache.md](../cache.md)。旧 session 保留，切换前明确新 epoch 的记忆迁移方式；不得改写已存在的 provider prefix。本方案暂不需要 SQLite schema 或 IPC 协议变更。

Debug impact：继续使用 bot/message/run/epoch/event identity；以固定枚举区分模型沉默、provider 失败、压缩无候选、成功发送与 unknown outcome。新增日志只记录有界计数与类别，不记录正文、图片、路径、模型响应或 tool args；业务判断仍以数据库、session 和发送结果为准。

本轮完成的验证：

- `bun test`：164 pass，0 fail。
- `bun run check`：通过。
- `bun run lint`：通过。
- `bun run docs:check`：未通过，环境缺少 `mdbook`，错误为 `Executable not found in $PATH: "mdbook"`；没有为审查安装依赖。
- 额外复现均为内存 fixture 或生产 session 的只读计算；未跑 opt-in e2e。

现有测试通过不意味着上述缺陷不存在：R2 需要覆盖 Pi 准备步骤，R3 需要断言公开发送结果，R5 需要覆盖忙碌时新 trigger 的关联身份。这些回归应在获准实施时先补失败测试。

本记录保留此次证据与审核方案。修复后的实际行为、命令和 invariant 应更新到 architecture/cache/testing/runbook 的各自权威文档，避免把本记录当作已经生效的运行说明。
