# 数据模型

> 描述当前 schema 真正表达的内容。schema 变化时同步更新。

存储：SQLite（WAL），默认单文件 `data/agent.db`。`messages` 是最新读模型；`message_events` 是 provider-facing 的不可变消费源。

Discord 入口独立运行，使用 `data/discord-agent.db`（SQLite）及 `data/discord-sessions/`，不与 Telegram daemon 的 `data/agent.db` 混用。以下 Discord 记忆表由 Discord 入口初始化。

## Telegram source 与读模型

### raw_updates

- `(bot_id, update_id)` 主键，保存完整 Telegram update JSON，用于去重、诊断和 replay。
- retention 默认 30 天；仍被 pending dispatch 引用的来源不会删除。poller offset 与 ingest、pending dispatch 在同一事务提交。

### pending_telegram_dispatch

- `bot_id` 主键，每个 poller 最多保存一条未交付 handoff；保存 update/message identity、kind 与 route_version，不复制正文。
- `(bot_id, update_id)` 外键引用 `raw_updates`。routing/control 回调成功后删除，失败和重启先交付再拉取新 update；accepted routing claim 防止重放重复触发。

### telegram_control_messages

- `(chat_id, message_id)` 主键，永久保存 control command/reply 的排除身份，与 telemetry 保留期独立。
- 启动迁移一次性从历史 `agent_events` 的 control claim/reply 回填现存身份，并记录 `control_identity_migrated`；后续读写只有本表。此前已被 retention 删除的身份无法凭空恢复。

### messages

- `(chat_id, message_id)` 主键；多个 bot 看到同一群消息只保留一条 canonical 最新投影。
- 保存 sender、reply/quote/forward、text/caption/entities、bounded Rich Message source、edit time 与 media identity。仅更新更大的 edit_date，跨 bot 乱序或同时间副本不会倒退 canonical 或追加 edit event。
- `reply_to_sender_id` 是 Telegram 嵌入父消息 sender 的有界 snapshot；缺失时 router 可查询 canonical parent。
- Rich Message source 上限 256 KiB；`text` 是确定性、最多 32,768 code points 的 plain projection。IPC/Pi/provider 不接收 raw source。

- `idx_messages_media_identity` 对非空 media 的 `CAST(json_extract(media, '$.file_unique_id') AS TEXT)` 建部分表达式索引；media lifecycle 使用完全相同的 TEXT 表达式按身份查找，避免每个文件重扫消息历史。

### message_revisions

- `(chat_id, message_id, edit_date)` 主键，保存被替换版本的 text/caption/entities/rich source。
- revision key 使用被替换版本自己的时间：原始版本用 `date`，后续版本用当时的 `edit_date`。

### message_events

- `ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT` 是全局单调位置；`event_key` 唯一保证 replay 幂等。
- `(chat_id, ingest_seq)` 索引是 agent 增量读取主路径；另有 message/时间索引用于 obligation 与 retention。
- kind 为 `message | edit | metadata | media_update`。payload 是该事件发生时的 bounded snapshot；旧 event 不因 canonical row、vision 或 edit 改写。
- message insert、edit 和 reply metadata enrichment 由事务内 trigger 追加；vision 模式下非空 vision completion 追加独立 `media_update`，context 模式不追加媒体 event——图片以 image 内容块随所属 message event 一起进入 provider context。schema v16 migration 是纯 additive（只增列），不删除或改写任何历史 event。
- 旧库 migration 从 canonical `messages` backfill baseline event，并把已知 bot cursor 初始化到 backfill high-water，避免把历史当 fresh context 重放。

## 每 bot context 与 routing 状态

### bot_cursors

- `(bot_id, chat_id) → consumed_seq`，表示业务消费到的 `message_events` high-water。
- cursor 只单调前进；compaction、visibility replacement 与 epoch 轮换不得回退它。
- daemon 启动删除不在当前配置中的 bot id 的 cursor 与 `reply_obligations` 行：retention 以配置 bot 的 `MIN(consumed_seq)` 为界，失效 id 不得永久钉住它。
- `messages`/`message_events` 的 trigger 以 `CREATE TRIGGER IF NOT EXISTS` 建立；修改 trigger body 时 `migrate()` 必须先 `DROP TRIGGER`，否则旧库不会更新。

### bot_visible_messages

- `(bot_id, chat_id, message_id)` 主键，并记录 `context_epoch`。
- 只表示完整消息内容当前真实存在于 Pi context；delta 或被预算跳过的 event 不会伪造 full-message visibility。
- 成功 send 返回的本 bot message id 可加入 visibility。成功 compaction 按 structured retained details 替换整组；新 session 清空旧 epoch visibility。

### bot_session_manifest

- 每 bot 保存 `session_id`、`session_file`、完整 `context_fingerprint` 与创建时间。
- runtime 在 restore 前计算 fingerprint；只有 fingerprint 相同且文件存在才 resume。mismatch 保留旧 session 文件并原子指向新 session。

### reply_obligations

- `(bot_id, chat_id, message_id)` 主键，只保存必须交给目标 bot 的 direct human address identity（explicit @mention / reply / 配置名称点名），不保存正文。
- 所有 direct-address obligation 由 runtime trigger 按最终目标在消息尚未可见时幂等创建（INSERT OR IGNORE）；创建前的路由窗口由 pending dispatch 保护，不在 ingest 预建另一个目标。
- runtime 每次有界读取最多 64 条；只有 session 中的结构化 context commit marker 证明 delivery 后才删除。crash/restart reconcile 幂等。

### routing_claims

- `(chat_id, message_id, bot_id, route_version)` 主键，记录 reason、status 和 timestamps。
- insert/enrichment/replay 都通过 durable claim 防止同一 bot 重复启动。pending/nonaccepted claim 可重取；accepted started/coalesced 是永久抑制证据。

### bot_state / daemon_state

- `bot_state` 保存 per-bot epoch、Telegram update offset 与 bot identity（`bot_user_id` / `bot_username`）；legacy `exposed_ids` migration 后删除，不再承担 context 状态。routing/cooldown 的运行时调整不写 DB——`/set` 直接写穿 `telegram.config.ts`（见 `docs/architecture.md` 配置节）。
- `daemon_state` 保存 deployment-wide router secret、schema/cache version 等 singleton metadata。
- bot id 均为 `TEXT`，配置定义实际 bot 集合，代码不假设 A/B。

## 媒体、agent 与 telemetry

### media / media_file_ids

- `media.file_unique_id` 是共享身份；`media_file_ids(bot_id,file_id,file_unique_id)` 是 bot-specific 可发送能力。
- short id 由 rowid 单调分配；不能用 `COUNT+1`。
- `vision`（JSON `{model,kind,text,at}`）保存 vision 模式的文字描述，`context_files`（JSON `[{name,mime}]`）保存 context 模式派生图片引用；两者都按 identity 持久化并跨 bot 复用，同一 identity 只识别/准备一次。Sticker 的 `mime` 规范化为 `image/webp`、`application/x-tgsticker` 或 `video/webm`，供 catalog 标注格式；可发送性仍以 bot-specific mapping 为准。≤1 MiB static display image与≤20 MiB video source先写0600临时文件再同目录rename；bytes与绝对path不进SQLite，`local_path`只保存当前`data/media`内的cache-relative basename。daemon启动按basename迁移旧绝对值，缺失或不支持的目标清空；video path与`context_files`派生图片只供本地抽帧/投影读盘，不进入IPC。
- `local_path` 与 `context_files` 都是可再生cache指针，不是媒体事实。任一当前配置bot的visible message、pending reply obligation或未消费非`media_update` event构成活跃引用；成功compaction提交visibility后最多清理256个无引用identity：source与派生图片一起unlink，两列同时置空，其他失败保留以便重试；启动backfill也只恢复仍有活跃引用的static display缺口。回收不删除media row、vision结果、short id、format、file mapping、canonical history或session；重新需要时可下载source且不重付已有vision结果，或重新准备派生图片。

### agent_events

- append-only 本地行为流：assistant/tool/vision/usage/compaction/error/send/control/context commit 等；context 模式媒体准备失败记 error（`stage=context_media`），不阻断打包，消息仍以纯文本占位进上下文。
- unpublished assistant prose 可以留在本地审计，但 provider session 仅保留 `[no_send]`。
- 一次agent run的原始assistant/tool/send事件用payload内的`activity_id`关联；settle时另追加一条有界`agent_activity`作为TUI单卡投影。原始行仍是debug authority，timeline只隐藏带`activity_id`的新式原始行，不重写旧历史。
- error/send/vision telemetry 使用固定 category 与 bounded fields，不保存 token、正文、prompt、response、完整 URL、path 或 stack。

### llm_runs

- 每次 provider response 记录 usage/cost/latency/epoch、thinking/send耗时，以及 provider/api、session id hash、cache retention、system/tools/messages/full payload HMAC 与首次 divergence 位置。`system/tools/compacted_history/message_tokens`保存按payload形状归一到实际provider总token的分段估算；`cache_read/cache_write/cache_miss` 保留 provider 原值。
- 同时记录 trigger message、public send count、vision calls（vision 模式）、本轮附加进上下文的图片数 `images_attached`（context 模式）、tool follow-up rounds、input event 数、保守 token estimate 与 rows scanned。schema v16 migration 只新增 `images_attached` 列（additive），旧 `vision_calls` 列保留。
- status 的 lifetime totals 聚合**当前保留行**（含 compaction）；current context 只取最新 `compaction = 0` 主对话 run，不累计 occupancy。字段和公式以 `docs/telemetry.md` 为准。

## 其他表

- `aliases`：`(chat_id,user_id) → u<N>`，为无 username sender 提供稳定别名。
- Telegram control 的排除身份存于 `telegram_control_messages`；`agent_events` 只保留可过期的行为审计。

## Discord 成员记忆与庆祝

### discord_memory_profiles

- `(guild_id, user_id)` 主键；每台 Discord 服务器独立保存成员显示名、首次/最近出现时间、消息计数和生日。生日仅从成员明确的自述或本人控制操作录入，不推测。
- `/memory` 用于本人查看自己的档案，`/birthday` 用于本人设置或清除生日。该表不跨服务器共享。

### discord_memory_facts

- `(guild_id, user_id, fact_key)` 主键，保存有限类别的事实（如偏好、兴趣、角色、项目、时区、语言、目标和备注），并记录来源频道、消息及观察时间；更新同一类别时用新值替换旧值。
- 当前自动提取范围只包括明确的自我介绍、偏好和生日表达。敏感类别不会作为普通事实接受；记忆片段有条数和长度上限。

### discord_memory_relationships

- `(guild_id, member_a, member_b, relation_type)` 主键，成员 ID 排序后存储；互动关系来自实际提及或回复，朋友/同学等明确关系只在消息直接声明时记录，并累计出现次数、最近来源消息与时间。
- `/forget` 删除该成员在当前服务器的档案、事实、生日及其关系边，并写入该服务器的 `discord_memory_opt_out`。后续消息不会重新建立档案，直到成员使用 `/memory action:enable`；此操作不影响其他服务器的数据。

### discord_memory_observed_messages / discord_memory_opt_out

- `discord_memory_observed_messages` 以 `(guild_id, channel_id, message_id)` 去重，确保消息重放不会重复增加互动计数。
- `discord_memory_opt_out` 按 `(guild_id, user_id)` 保存忘记/退出状态。记忆查询与生日列表都会排除退出成员。

### discord_celebration_deliveries

- `(guild_id, channel_id, persona_id, local_date, event_key)` 唯一标识一次本地日历事件的发送；状态为 `sending` 或 `sent`，成功后记发送时间。完成记录跨重启保留以抑制重复消息；明确发送失败会释放 claim。同一当地日的 `sending` 超过 30 分钟后允许重试，防止重启漏发；若 Discord 已收消息而进程尚未记成功，极端情况下可能重复一次。过期日期不会补发。
- 自动发送只针对 `discord.config.json` 中显式列出的 `celebrations` 频道；配置校验要求该频道属于对应 guild 的 allowlist，并要求指定已配置 persona、IANA 时区和节日日历。生日每名成员单独一条，仅允许提及本人；节日每个事件/目标最多一条，不解析全体提及。

### Discord soul 文件

- persona 自身的正式 `soul.md` 位于 `data/discord-souls/<persona-id>/soul.md`，新的短笔记先写同目录 `soul.pending.md`。两者不在 SQLite 内，也不与成员档案混存。更新工具只允许当前配置 persona 暂存笔记；成功压缩上下文后才合并进正式文件并清除 pending。正式文件限 4 KiB、pending 限 1 KiB，拒绝明显的密钥、成员隐私与提示注入内容；文件私有、原子替换，正式文件更新前留一个 `soul.md.bak`。

## Retention 与安全删除

daemon 启动时执行一次、之后每 24 小时执行 maintenance，并做 passive WAL checkpoint/optimize。默认：

- `agent_events` 与 `llm_runs`：90 天；
- `raw_updates`：30 天；
- `message_events`：365 天。

旧 `message_events` 只有在 `ingest_seq <=` 该 chat 所有已知 bot cursor 的最小值，且没有 reply obligation 或 pending dispatch 引用该 message 时才删除。canonical `messages`/revisions/media/session 文件不由这条定时 retention 清理；可再生的`media.local_path`与`context_files`派生文件另由成功compaction后的引用回收处理。

## ID / dedupe 边界

- update：`(bot_id, update_id)`；raw/canonical/event/pending dispatch/offset 在同一 transaction 内提交，失败整体回滚。
- canonical message：`(chat_id, message_id)`；second-bot duplicate 只允许幂等 enrichment。
- provider event：唯一 `event_key` + 单调 `ingest_seq`；edit 与 vision 模式 media completion 追加 delta。
- bot 自发消息：Telegram send result 立即 normalize/insert，随后 poller 副本按 canonical/event key 去重。

LLM 序列化 grammar 与 fingerprint 边界见 `docs/cache.md`。

## 非SQLite本地日志

`data/daemon.log`不是业务表，也不是恢复authority。它是schema v1 JSONL side channel，固定8 MiB后轮转并保留`.1`–`.3`，文件0600；debug报告最多读当前文件尾64 KiB。字段、隐私和关联契约见`docs/engineering/debugging-guide.md`。SQLite retention与log rotation彼此独立。
