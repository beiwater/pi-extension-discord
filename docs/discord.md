# Discord 部署指南

本文说明如何把当前 Pi 群聊助手运行在 Discord 服务器文字频道中。Discord 入口与 Telegram daemon 分开启动；bot token、模型密钥和允许接收消息的频道由本地配置决定。

## 能力与边界

- 多个 persona 可以共用一个服务器，各自保留模型会话；被提及、被回复或按名称点名时优先响应，其余消息按 `routingP` 概率路由。所有 persona 的 `routingP` 总和不能超过 1。
- 服务器文字频道和该频道下的 thread 可用。每条 persona 的会话按频道/thread 隔离。
- 会话持续保存频道上下文；模型可在一轮回答中反复调用工具继续处理。`reasoningEffort` 可设为 `low`、`medium` 或 `high`，提高推理强度会增加延迟和模型费用。
- 配有 `DEEPSEEK_API_KEY` 时，Bot 可用同一个密钥调用 DeepSeek 的联网搜索，再根据搜索结果回答并附来源链接。明确说「查一下」「搜索」的消息会先搜索，再交给模型回答；其他外部事实也可由模型调用 `search_web`。没有该密钥时不会注册搜索工具；搜索会增加 DeepSeek 的模型用量。
- Bot 可以调用 `run_js` 做精确计算、单位换算和简单数据处理；它在隔离的短时子进程内运行，不能访问文件、网络或环境变量。
- Bot 可读取最多 4 张 Discord 图片附件（单图最多 20 MiB，进入模型前会缩放）；不处理普通文件、语音或视频。
- Bot 可按模型选择发送文字或项目内置的 4 张 PNG 表情图片（hello、laugh、think、hug）；这些是普通图片附件，不是 Discord 服务器贴纸。发图需要 `Attach Files`。
- Bot 可调用 `react_to_message` 给频道内最近的人类消息点 Discord 表情，作为不发文字的简短回应；需要 `Add Reactions` 权限。
- 配好 Fish Audio 后，Bot 可调用 `speak` 发送带文字稿的 MP3 语音回复，支持中文、日文和英文。默认只在明确要求语音或短语音特别合适时使用；需要 `Attach Files` 权限。
- 提供 `/help`、`/status` 和 `/ask` application commands。暂不提供 Telegram 的 `/compact`、`/set`、管理面板、语音频道或贴纸功能。
- Discord 消息正文及会话保存在 `data/discord-agent.db` 和 Pi session 文件中；图片缓存在 `data/media`。部署目录只应由受信任的运维账号访问。

## 创建 Discord bot 并安装到服务器

每个 persona 使用一个 Discord application 和对应 bot token。若只运行一个 persona，创建一个 application 即可。

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建 application，在 **Bot** 页面添加 bot 并复制 token。token 只放在服务器私有 `.env` 中。
2. 在 **Bot → Privileged Gateway Intents** 中启用 **Message Content Intent**。当前程序订阅服务器、服务器消息和消息正文 intents；未启用时，bot 无法按普通群聊内容路由。
3. 在 **OAuth2 → URL Generator** 选择 `bot` 与 `applications.commands` scopes。为 bot 选择 `View Channels`、`Send Messages`、`Read Message History`、`Send Messages in Threads`、`Attach Files`、`Add Reactions`。不要授予 Administrator。
4. 打开生成的邀请链接，把 bot 加入目标服务器。需要响应的频道必须允许该 bot 查看与发送消息；thread 需要允许 bot 在 thread 中发言。
5. 若一个 persona 有独立 bot，需要为每个 application 重复这些步骤，并分别填入 token。

Discord 官方说明：[Gateway intents](https://docs.discord.com/developers/events/gateway)、[OAuth2 scopes](https://discord.com/developers/docs/topics/oauth2#shared-resources-oauth2-scopes)、[权限](https://docs.discord.com/developers/topics/permissions)。

## 配置

在项目根目录复制示例文件：

```bash
cp discord.config.example.json discord.config.json
```

编辑 `discord.config.json`：

- `guildId`：目标服务器 ID。
- `channelIds`：明确允许 bot 接收和发送消息的频道 ID。建议只加入需要 bot 的频道；thread 使用其父频道的 allowlist。
- `dataDir`：会话、SQLite 数据库和媒体缓存目录，默认 `data`。
- `routingSecretEnv`：`.env` 中路由密钥的变量名。
- `personas`：每个 bot 的唯一 `id`、显示 `name`、token 环境变量名、persona 文件、Pi `provider` / `model`、`reasoningEffort` 与 `routingP`。persona 文件放在项目目录中或填可读路径。
- `voice`（可选）：Fish Audio 密钥的环境变量名、公开音色的 `referenceId` 与模型。删除此项即禁用语音工具。

Snowflake ID 必须作为 JSON 字符串，例如 `"123456789012345678"`，不能写成 JSON 数字。

在项目根目录 `.env` 中写入私密值。此项目使用 `key: value` 格式，不是 `KEY=value`：

```text
DISCORD_LUNA_TOKEN: 从 Developer Portal 复制的 bot token
DEEPSEEK_API_KEY: DeepSeek API key
DISCORD_ROUTING_SECRET: 由密码管理器生成的随机长字符串
FISH_AUDIO_API_KEY: 从 Fish Audio 开发者后台创建的私密 API key（启用 voice 时才需要）
```

`.env` 已被 Git 忽略；不要提交它、token 或模型 key。Discord 配置、persona 内容、数据库与 session 也应按部署私有数据处理。

示例 persona 选择 `provider: "deepseek"`、`model: "deepseek-flash"`。启动时程序会在 `data/pi-agent/models.json` 建立非敏感模型目录，认证仍由 `.env` 的 `DEEPSEEK_API_KEY` 提供。若你改用其他已由 Pi 安装并登录的 provider/model，必须填对应的 Pi provider/model，并确保该 provider 的认证可用。

搜索使用 DeepSeek [Anthropic 兼容接口支持的 Web Search](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)，每次工具调用最多执行一次网页搜索。搜索资料是不可信输入；Bot 应核对来源，搜索失败时说明无法核实。`/ask` 与普通提及都可触发搜索。

启用 Fish Audio 语音时，在 `discord.config.json` 顶层添加，例如：

```json
"voice": {
  "apiKeyEnv": "FISH_AUDIO_API_KEY",
  "referenceId": "933563129e564b19a115bedd57b7406a",
  "model": "s2.1-pro-free"
}
```

示例音色是 Fish Audio 官方提供的 Sarah；可在 [Fish Audio 音色库](https://fish.audio/app/discovery/) 换成适合自己的公开女声 `referenceId`。`s2.1-pro-free` 支持中、日、英等语言；免费层有公平使用限制，具体以 [Fish Audio 官方价格表](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits) 为准。

## 启动与试用

安装依赖并以前台方式启动：

```bash
bun install
bun run discord:start
```

启动时会验证配置、bot 身份、Pi 模型和 token，然后注册服务器级 `/help`、`/status`、`/ask` 命令并连接 Discord Gateway。将 bot 在线状态确认后，在 allowlist 频道中提及 bot 或使用 `/ask` 试用；普通消息是否有人设回应由路由概率决定。`routingP: 0` 可让某 persona 只响应明确提及、回复或名称点名。

Discord Bot 页面若漏开 Message Content Intent，或 bot 没有频道权限，启动或消息响应会失败。日志只输出错误类别，不会显示 token。

## Linux 常驻运行

建议使用专用 Linux 用户，在该用户家目录放置代码、`.env`、`discord.config.json`、persona 文件和 `data/`。不要把 `.env` 放到 Git 或共享目录。可使用 systemd user service：

```ini
# ~/.config/systemd/user/pi-discord-agent.service
[Unit]
Description=Pi Discord Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/pi-extension-discord
ExecStart=%h/.bun/bin/bun run discord:start
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

把 `WorkingDirectory` 改为实际部署目录，然后运行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-discord-agent
systemctl --user status pi-discord-agent
journalctl --user -u pi-discord-agent -f
```

要在未登录时随开机启动，可为专用用户启用 systemd lingering：

```bash
sudo loginctl enable-linger <linux-user>
```

更新代码或配置后重启：

```bash
systemctl --user restart pi-discord-agent
```

## 核验

在仓库根目录运行：

```bash
bun run check
bun run test
```

然后在指定频道核验三种路径：提及 bot、回复 bot、`/ask`。再确认 allowlist 外频道不会触发 bot、图片附件可作为模型输入、bot 回声不会引发自我回复，以及 systemd 重启后会话仍可恢复。
