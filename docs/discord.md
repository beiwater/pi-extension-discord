# Discord 部署指南

本文说明如何把当前 Pi 群聊助手运行在 Discord 服务器文字频道中。Discord 入口与 Telegram daemon 分开启动；bot token、模型密钥和允许接收消息的频道由本地配置决定。

## 能力与边界

- 多个 persona 可以共用多个服务器，各自保留模型会话；被提及、被回复或按名称点名时优先响应，其余消息按 `routingP` 概率路由。所有 persona 的 `routingP` 总和不能超过 1。
- 服务器文字频道和该频道下的 thread 可用。每条 persona 的会话按服务器、频道或 thread 隔离，不会把 IDK 与其他服务器的聊天混在一起。
- 会话持续保存频道上下文；模型可在一轮回答中反复调用工具继续处理。`reasoningEffort` 可设为 `low`、`medium` 或 `high`，提高推理强度会增加延迟和模型费用。
- 配有 `DEEPSEEK_API_KEY` 时，Bot 可用同一个密钥调用 DeepSeek 的联网搜索，再根据搜索结果回答并附来源链接。明确说「查一下」「搜索」的消息会先搜索，再交给模型回答；其他外部事实也可由模型调用 `search_web`。没有该密钥时不会注册搜索工具；搜索会增加 DeepSeek 的模型用量。
- Bot 可以调用 `run_js` 做精确计算、单位换算和简单数据处理；它在隔离的短时子进程内运行，不能访问文件、网络或环境变量。
- Bot 可读取最多 4 张 Discord 图片附件（单图最多 20 MiB，进入模型前会缩放）；不处理普通文件、语音或视频。
- Bot 可按模型选择发送文字或项目内置的 4 张 PNG 表情图片（hello、laugh、think、hug）；这些是普通图片附件，不是 Discord 服务器贴纸。发图需要 `Attach Files`。
- Bot 可调用 `react_to_message` 给频道内最近的人类消息点 Discord 表情，作为不发文字的简短回应；需要 `Add Reactions` 权限。
- 配好 Fish Audio 后，Bot 可调用 `speak` 发送带文字稿的 MP3 语音回复，支持中文、日文和英文。默认只在明确要求语音或短语音特别合适时使用；需要 `Attach Files` 权限。
- 普通文字回复可使用 Discord 的 Markdown 富文本，包括加粗、斜体、小标题、列表、引用、代码块、链接和剧透标记；提示词要求按内容适度排版。Discord 的 `embeds` 是另一种结构化消息字段，当前入口没有生成它。单条正文最多 2000 字符，长回复由发送端分段；数学公式用纯文本表达。参见 Discord 的 [Markdown 指南](https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline)与 [Create Message 文档](https://docs.discord.com/developers/resources/message#create-message)。
- 提供 `/help`、`/status`、`/ask`、`/memory`、`/birthday` 和 `/forget` application commands。配置 `adminUserIds` 的 persona 另提供 `/context` 和 `/compact`，仅允许列出的 Discord 用户查看当前频道上下文用量或手动压缩；管理和记忆命令响应只对调用者可见。当前默认 DeepSeek 模型上下文窗口为 65,536 tokens，自动压缩在约 49,152 tokens 之后触发。
- 每个 Discord 服务器分别维护成员档案、明确表达的偏好与关系记录；Bot 会从成员在群内明确说出的生日/姓名/偏好及实际提及、回复等互动更新档案，不把猜测当事实。跨服务器不会共享成员记忆。成员可用 `/memory` 查看自己的档案、`/birthday` 设置或清除生日、`/forget` 删除本服务器的结构化档案和关系并停止继续记录；忘记后需由成员使用 `/memory action:enable` 才恢复记录。`/forget` 不会删除 Discord 原消息或已有 Pi 会话历史。
- persona 可通过私人 soul 更新工具提交新的风格与自我反思。新笔记先私有暂存并在会话尾部生效；下次成功压缩上下文后才合入正式 `soul.md` 并重载系统提示词。笔记不保存成员隐私，受长度和敏感信息检查，旧正式版本保存在私有备份中。
- 生日提醒与节日祝福默认关闭。只有在 `celebrations` 中为服务器显式配置一个允许频道后，才会在该频道当地时间 09:00 后发送；生日祝福单独 @ 当事人，节日祝福不 @ 全体。时区使用 IANA 名称，节日历可选中国、澳洲或两者。当前中国节日覆盖元旦、春节、劳动节、端午节、中秋节、国庆节；澳洲节日覆盖元旦、Australia Day、Good Friday、Easter Sunday、ANZAC Day、圣诞节与 Boxing Day。2 月 29 日生日在平年于 2 月 28 日祝福；州别补假、调休不在本日历内。
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

- `guilds`：服务器列表；每项包含 `guildId` 和 `channelIds`。为每个服务器填入要启用的频道 ID；thread 使用其父频道的 allowlist。例如可同时配置现有服务器和 Valorant 服务器的 `#化学`、`#物理` 频道。
- `dataDir`：会话、SQLite 数据库和媒体缓存目录，默认 `data`。
- `routingSecretEnv`：`.env` 中路由密钥的变量名。
- `personas`：每个 bot 的唯一 `id`、显示 `name`、token 环境变量名、persona 文件、Pi `provider` / `model`、`reasoningEffort` 与 `routingP`。persona 文件放在项目目录中或填可读路径。可选 `adminUserIds` 是允许使用该 bot 管理命令的 Discord 用户 ID 列表；这不会授予 Discord 服务器 Administrator 权限。`guildIds` 可将某个 persona 限定在配置过的服务器子集；省略时沿用全部 `guilds`。`aliases` 添加额外的名称点名词。`sendReactionImages` 和 `voiceEnabled` 分别控制该 persona 是否能发 reaction 图片、是否使用全局 Fish Audio 音色；默认均为 `true`，设为 `false` 会同时移除对应工具和提示词。
- `celebrations`（可选）：显式启用自动生日提醒和节日祝福的目标列表。每项指定 `guildId`、`channelId`、`personaId`、IANA `timeZone` 和 `calendar`（`china`、`australia` 或 `both`）；目标频道必须同时出现在该服务器 `channelIds` allowlist 中。省略该字段或设为空数组即关闭自动发送。配置示例使用虚构 ID，部署时应替换为自己的服务器和频道 ID。
- `voice`（可选）：Fish Audio 密钥的环境变量名、公开音色的 `referenceId` 与模型。删除此项即禁用语音工具。

例如，显式为配置服务器的一个允许频道开启悉尼时区的中澳节日历：

```json
"celebrations": [
	{
		"guildId": "000000000000000000",
		"channelId": "000000000000000001",
		"personaId": "luna",
		"timeZone": "Australia/Sydney",
		"calendar": "both"
	}
]
```

仅将生日告诉 Bot 不会让它向任意频道发送消息；自动祝福只使用这里明确配置的频道。`/birthday` 可登记或清除自己的生日，`/memory` 可查看自己的记录，`/forget` 可删除本服务器记忆并停止收集；生日与档案均按 Discord 服务器隔离。

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

启动时会验证配置、bot 身份、Pi 模型和 token，然后为每个配置的服务器注册 `/help`、`/status`、`/ask`、`/memory`、`/birthday`、`/forget` 命令；配置了 `adminUserIds` 的 bot 还注册 `/context`、`/compact`，随后连接 Discord Gateway。将 bot 在线状态确认后，在 allowlist 频道中提及 bot 或使用 `/ask` 试用；普通消息是否有人设回应由路由概率决定。`routingP: 0` 可让某 persona 只响应明确提及、回复或名称点名。

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

然后在指定频道核验三种路径：提及 bot、回复 bot、`/ask`。再确认 allowlist 外频道不会触发 bot、图片附件可作为模型输入、bot 回声不会引发自我回复，以及 systemd 重启后会话仍可恢复。启用了 `celebrations` 时，检查目标频道、时区及生日名单，并确认未配置的频道不会收到自动消息。
