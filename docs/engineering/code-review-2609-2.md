# 2026-09-16 生产故障诊断与全面整改

时间点记录。生产主机 `adv.mizore.blog`（Arch Linux，systemd user unit），两 bot 同一 antigravity 代理模型。

## 故障诊断

现象：两 bot 数日基本不回话；9-16 当天 423 个 turn 仅 7 次 send，`provider_retry_scheduled` 1937 次，`compaction_failed` 594 次。

从 Pi session JSONL 只抽取 assistant `errorMessage`（不读正文）得到上游错误串：9-15 10:00Z 起持续 `429 model_cooldown "Individual quota reached… Resets in 71h"`，9-16 13:35Z 起短暂 `400 model_not_found`，13:42Z 恢复。

配额耗尽是代码造成的：`llm_runs` 显示 9-13 单日 A 50M + B 32M ≈ 82M input tokens（含 44M cache read），来源是下面三个结构性问题叠加。

### 1. 图片对 Pi compaction 切点不可见（"图像 bug"）

上下文图片只存在 `custom_message.details`，Pi 的 chars/4 估算对它们计 0。在真实 session 上只读 dry-run：Pi 原切点保留 A 41 张 / B 58 张图（≈65k / 84k provider tokens），远超 20k 的 `compaction_keep_recent`。B 保留窗口本身 >100k，每个 turn 都重新越过 114,688 阈值 → 几乎每 turn 一次 compaction（9-13 A 248 次），每次多付一个摘要请求并抹掉近期记忆；故障期间 B 的请求膨胀到 729k tokens / 29 MB 图片。

修复：`tg-compaction` 在 `session_before_compact` 里按每张 `CONTEXT_IMAGE_TOKEN_ESTIMATE` 计费，用 Pi 公开的 `findCutPoint` 求更晚的合法 cut，被多丢弃的 entry 一并进摘要输入；删除 `keepRecentTokens=1` 覆盖。

### 2. `role: "developer"` 未归入 system（"历史占比不正常"）

reasoning 模型下 Pi 用 `developer` 角色发 system prompt，`payloadSegments()` 只认 `system`，`/status` 显示 system 0%、messages ≈100%。一行修复。

### 3. 失败 turn 被当作已交付 / 零 usage 行

Pi 耗尽 retry 后正常 resolve turn，flush 把 @mention 标为已交付（故障期间点名被静默丢弃），并为每次失败 attempt 写一条零 usage `llm_runs`（吃掉本 turn 的 input metrics、把成功 attempt 标成 follow-up）。修复：失败 turn 记 `reply_obligation_retained`、不写 marker / usage、不立即重跑；`maybeAutoCompact` 删除与 Pi 重复的 token 分支，并在上一 turn 失败时跳过。

## 全面整改（四区并行 review 后一次落地）

daemon / ingest / config：pid lock 只接管已死 pid；poller 致命错误走 `shutdown()`；control 命令在 durable handoff 内 await；`groupChatId` 计算一次（删 13 处派生与 `isTargetChat` 两种错误形式）；`NUMERIC_RANGES` 统一顶层/per-bot 范围；`botOverrides()` 共用；`TelegramApiError.kind` 替代 "non-json" 字串匹配；`compactForControl` 按 branch 结构而非 Pi 错误文案判断；未配置 bot 的 cursor/obligation 启动清理；删除 control port 间接层、poller/ipc null 分支、死导出与 DI seam。

media / tools：`prepareMediaImages()` 统一 vision 与 context 的下载→抽帧/转码→resize 管线（1024px / 200KB）；vision 不再持久化 transient 失败；context-media 返回 `{ok, outcome}` 并真正记录 `stage=context_media`；run_js 在 vm 内限制每条字符串长度、不透传截断 stdout；`assignStickerShortId()` 替代三份 rowid 复制；`cacheDir`/`videoTranscoder` 必填。

TUI：live 事件携带 `evtId`/`ts`（重连不再重复卡片）；usage 增量折叠进 baseline（删 256 上限）；`BotStats.lastRunId` 让 footer 在 compaction 后显示 `?`；footer 用 daemon 钳制后的 window；`teardownFeed` / `patchItems` / `BoundedTtlMap` / 缓存 config 读取；删除 `composeGeneration`、`mediaGeneration`、status 管线、版本门、命令树不可达分支、未用导出；`DAEMON_READY_MESSAGE` 与 CLI 共用；占比合计 100.0、本地时区。

未做并明确保留：`media.semantic` 与 `messages.sender_tag` 两列——删除需重建 trigger 并重写 85k 行表，收益不足；`compaction_keep_recent` 仍按 Pi chars/4 计文本，CJK 实际约 3 倍（文档已说明）。

## 验证

- 本地与 Linux 生产主机：164 tests / 0 fail，`check`、`lint`、`docs:check` 通过。
- 部署：备份在 `~/telegram-deployment-backups/20260916T150501Z`（源码、worktree diff、SQLite）；旧工作树 `git stash`（`pre-deploy-20260916T150501Z`）；checkout `deploy-20260916` 分支；`systemctl --user restart telegram-agent`。旧 daemon 优雅退出（在途 send 完成），新 daemon 以相同 fingerprint 恢复两 session，并恢复了停机前 coalesced 的 name-mention obligation。
- 部署后 8 分钟：A 压缩后上下文 42k（此前 ~90k），B 45k（此前 >100k）；`system_tokens` 12–15k；2 次 compaction、0 错误、7 次 send。
