# Antigravity 插件（agy-acp）

在 Cindy 打开 Antigravity 插件设置，可检测本机 CLI、从 Google 官方发布源安装及检查更新。已有自定义安装位置时，更新交给该 Antigravity CLI 的原生更新命令，它的输出也会进入安装日志。安装或更新时，设置页显示当前步骤、已用时间，下载时显示进度、速度和剩余时间；可展开的安装日志列出每一步和安装程序的输出（用户目录显示为 ~，凭据会被隐去）。日志只保存在插件运行期间，重新打开设置页也能看到。

从旧版升级时，请从新仓库下载 .cindy 文件并在 Cindy 导入一次，之后插件更新将使用 makecindy 下的新地址。

把本机已安装、已用 Google 账号登录的 Google Antigravity 命令行（`agy`）作为 Cindy 的任务执行引擎。
插件通过清单的 `harnesses` 字段声明一个 ACP 引擎，Cindy 在模型选择器里显示「Antigravity」，
选中后每个任务启动一个 `agy acp` 进程，用 [Agent Client Protocol](https://agentclientprotocol.com) v1
与它对话。

插件负责「找到 agy、报告能不能用、列出 agy 提供的模型、思考深度与工作模式、为 Cindy 的账号管理登录 agy、
把字节原样转发」。它不安装、不分发 agy；登录由 agy 自己完成并保存，账号在 Cindy 的「设置 → 模型供应商」里添加和管理。

## 安装与更新

1. 从本仓库的 [Releases](https://github.com/makecindy/cindy-antigravity-plugin/releases) 下载最新的
   `agy-acp-<版本>.cindy`，在 Cindy 的插件页导入。安装确认会列出 Node 工作进程（本机权限）和
   「提供执行引擎 Antigravity」两项权限。
2. 之后在插件设置页的宿主区域即可检查并安装新版本：清单里的 `githubRelease` 指向本仓库，
   Cindy 读取 GitHub Release、校验附件摘要后走插件更新确认，启用状态、配置与数据保持不变。
3. 需要支持插件执行引擎的 Cindy，见下方「前提条件」。

## 账号用量

Cindy 在「设置 → 模型供应商 → Antigravity」里逐账号显示各模型组的剩余额度和重置时间，也会在使用此引擎的任务输入框下方显示用量，点击可看明细；插件设置页不再显示用量。数据来自本机 agy 的原生 `/usage` 命令，查询不会发起模型对话。旁边的圆环显示当前任务由引擎上报的上下文占用。额度周期能明确识别时（如 `5h`、`weekly`），用量里会一并带上窗口时长（`windowMinutes`），供 Cindy 判断哪份额度更快重置；认不出的周期不带。

## 让自己的其他电脑使用与分享给朋友

在插件设置里为「Antigravity」打开「允许被远程调用」后，同一账号的另一台电脑无需安装本插件或 agy，
新建任务时即可直接选择这台电脑的 Antigravity；你也可以点击旁边的「远程与分享」生成一次性链接，
把这台电脑上的 Antigravity 分享给朋友免安装使用：Agent 在这台电脑上运行，用这里的 agy、登录和额度；
项目文件与命令仍在任务所在的那台电脑。开关默认关闭，只能在这台电脑上改。暂不支持加入供应商组。
需要 agy 1.5.13 或更高版本。

这类任务里 Antigravity 自带的读写文件、搜索文件和执行命令的工具都不存在（它们只能碰到这台电脑，项目不在
这里），只保留联网搜索和它内部的后台任务管理；文件和命令改用 Cindy 提供的工具，在任务所在电脑上执行。做法只对这一次启动生效，
不改你的 Antigravity 设置、登录和自定义 Agent，你自己在终端里用 agy 不受影响：

- 插件在一个只属于这次任务的临时目录里放一份自定义 Agent 定义（只允许联网搜索这一个自带工具，并写明可用的
  Cindy 工具服务的名字），用 `agy acp --agent` 启动，任务结束即删除。工具服务的地址和任务令牌只随建会话的
  请求传给 agy，不写进任何文件。
- agy 没有声明支持 HTTP 方式的外部工具（实际支持），插件在握手回包里补上，Cindy 才会把工具交过来。
- agy 报告外部工具的方式和 Cindy 不同（新会话里是「MCP Tool …」，重开任务后是 `mcp_<服务>_<工具>`）；
  插件把它们还原成 Cindy 自己的工具名和参数再交给 Cindy，所以任务里看到的是 Bash、Read、Write 等，
  确认卡片也按实际命令和文件显示。
- agy 没有办法在启动前核对实际生效的工具，所以插件在任务进行中盯着：一旦出现不是 Cindy 工具、却在读写文件
  或执行命令的调用，立即结束任务并说明原因。版本低于 1.5.13 的 agy 直接拒绝启动。

与本机任务相比的差别：

- 这类任务使用上面那份自定义 Agent 的说明，而不是 Antigravity 默认 Agent 的完整说明，回答风格可能略有不同；
  Antigravity 自带的浏览器、子 Agent 等能力在这类任务里不可用。
- 重开任务（或闲置后重新连上）之后，agy 不再随工具卡片带回工具的输出，卡片里只看到调用了什么；结果仍会
  写在它的回答里。
- 以上行为在 agy 1.5.13 上实测；agy 升级后若表现变化，任务会被上面的检查停下，而不是在这台电脑上动文件。

## 前提条件

1. 支持插件执行引擎（清单 `harnesses` 字段与 `PUT /harnesses`，含模型的思考深度与 Agent 工作模式）的 Cindy。
   该能力仍在开发中；正式版发布后请把 `ghost.json` 的 `minCindyVersion` 改成第一个包含它的版本号。
2. 安装 Antigravity 命令行（[antigravity.google](https://antigravity.google)）。Windows 上默认装在
   `%LOCALAPPDATA%\agy\bin\agy.exe`，不需要加进 PATH。登录在 Cindy 的「设置 → 模型供应商 → Antigravity」里完成（见下），也可以在终端运行 `agy`。

## 本地安装（开发）

在 Cindy 的任务里让 Agent 调用 `ghost_forge_pack({ dir: "<本目录绝对路径>" })` 打包，再明确让 Agent 调用
`ghost_forge_install({ dir: "<本目录绝对路径>" })`，或在插件页导入生成的 `agy-acp-<版本>.cindy`。安装确认
会列出 Node 工作进程（本机权限）和「提供执行引擎 Antigravity」两项权限。

## Cindy 启动 agy 的方式

```
agy --settings {"useG1Credits":false} acp --disable-telemetry
```

- `--settings` 只对这次会话生效，不改你的 agy 配置：**订阅额度用完后不会使用付费的 Google AI 积分**，
  任务会报错停下。
- `--disable-telemetry`：Cindy 启动的会话不向 Google 发送遥测。
- 参数都是插件里的常量，不拼接任何用户输入。Windows 上若 agy 是 `.cmd` 包装，常量按 C 运行库规则加引号
  经 `cmd.exe` 传入（常量里没有 cmd.exe 会展开的字符，加载时校验）。

## 模型、思考深度与工作模式

插件在自己的一个探测会话里（不发消息，不会调用模型）读取 agy 的 ACP 配置项，随可用状态发布给 Cindy：

- 模型：`model` 配置项（例如 Gemini 4 Neon / Argon / Hydrogen、Gemini 3.8 Flash、Claude Opus / Sonnet 5.5）。
- 思考深度：逐个模型读取 `thought_level`，只上报 Cindy 认得的档位（agy 1.5.12 为 low / medium / high / xhigh，
  不同模型不同，Orchestrator 与 GPT-OSS 不可调）。
- 工作模式：`mode` 配置项（default / accept-edits / auto / plan）按 Cindy 权限档 id 上报。输入框的权限菜单
  列出这些模式，末尾是 Cindy 的「全部允许」；切换时 Cindy 让 agy 切到对应模式，agy 请求权限时仍由你确认。

探测会话的 id 由逻辑页存在插件数据里，Node 工作进程另记一份在本机配置目录的 `cindy-agy-acp/model-session.json`
（只有这个 id），供查询登录状态时复用同一个会话读取订阅档位。从 0.4.x 升级后，逻辑页启动时把已存的 id 交给
工作进程（工作进程已有记录时不覆盖，不启动 agy）。

打开模型选择器时 Cindy 会请插件刷新（同一插件 10 分钟内最多一次）。没有任何账号登录时引擎仍显示为可用，
以便在「设置 → 模型供应商 → Antigravity」里登录或添加账号；插件设置页会提示去那里添加。

## 账号

账号统一在 Cindy 的「设置 → 模型供应商 → Antigravity」里添加和管理。插件设置页不提供登录、退出和用量，只保留命令行的
检测、安装与路径设置，并提示到模型供应商管理账号。所有账号平等：agy 原有的登录（终端里的 `agy` 也在用的那一份）和
Cindy 新增的账号都是账号列表里的普通一行，按同一套策略分配任务。

- **登录**：Cindy 调用工作进程的 `accountLogin`，插件发 `authenticate`（`oauth-personal`），agy 自己打开浏览器走 Google
  登录，完成后返回；等待期间可以在 Cindy 里取消（结束这次的 agy 进程）。登录成功后立即重新读取模型。
- **状态**：Cindy 调用 `accountStatus` 检查是否已登录，并显示 agy 报告的订阅档位（例如 Google AI Pro）。
- **没有退出登录**：在 Cindy 里移除账号只是让 Cindy 不再使用它，登录和历史保留。要让 agy 原有的登录真正登出，请在终端的
  `agy` 里操作。

登录信息由 agy 保存在它自己的存储里（原有登录在系统凭据存储，新增账号在各自的账号目录），Cindy 不保存，插件也不打开
agy 的凭据文件。agy 1.5.18 的 ACP 与 `/usage` 只给订阅档位、不给账号身份，但它自己的日志会写明当前登录的邮箱
（`OAuth: authenticated successfully as …`，日志里没有令牌）。所以检查登录状态时，插件让 agy 把这一次的日志写到一个私有的
临时文件（`--log-file`），从中读出邮箱后立即删除。原有登录和新增账号用的是同一种办法，账号列表里每一行都显示实际的账号；
同一个 Google 账号既是原有登录、又被添加为新增账号时，两者的摘要相同，Cindy 能识别出来。日志格式若在以后的 agy 版本里变化，
读不到邮箱的账号只显示订阅档位，不会显示成别的账号。

支持引擎账号的 Cindy 可以在「设置 → 模型供应商 → Antigravity」中像 Claude Code / Codex 一样管理并添加多个
Google 账号，按账号池策略混用（最少占用、轮询、按顺序、按权重、余量最多）、限制并发、暂停、拆出为单独供应商，并在
额度用尽、登录失效或服务繁忙时自动换号与冷却：

- **原有登录**：终端里的 `agy`、以及升级前在插件设置页登录的那一份，仍是系统默认登录（OS 凭据存储 + `~/.gemini/antigravity-cli`），
  升级后无需重新登录，它作为一个普通账号出现在账号列表里。
- **新增账号**：Cindy 为每个新增账号建独立目录，启动任务或登录时传入 `--cindy-account-dir <目录>` / `accountDir`。
  插件以 `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` 和 `--gemini-dir <目录>/.gemini --app-data-dir antigravity-cli`
  运行 `agy acp`（不改写用户 `HOME`，任务里的 git / ssh 等工具仍正常工作），把该账号的 OAuth 凭据文件、设置和
  会话历史完全隔离在账号目录内；查询该账号 `/usage` 时以该目录为 `HOME`（Windows 同步设置 `USERPROFILE`）读取同一份
  凭据。账号目录不存在或不可写时直接以非零状态退出（退出码 77），绝不回落到默认登录。远程工作区和分享模式同样按该
  账号目录运行。
- **身份与去重**：`accountStatus` 从 agy 本次检查的日志里读取邮箱（`identity.email`），并给出由邮箱哈希得到的
  稳定摘要（`fingerprint`，不含任何令牌），供 Cindy 显示账号邮箱并在重复登录同一 Google 账号时只计一次调度；原有登录
  与新增账号一视同仁。套餐名称来自 ACP 订阅档位。
- **自动换号分类**：入口在 `session/new`、`session/load`、`session/resume`、`session/prompt` 失败回包里，把明确的
  登录失效、额度耗尽（含未来重置时间，如有）与模型容量不足/限流标成 `error.data._meta.cindy`
  （`auth-required` / `usage-limit` / `overloaded`），供 Cindy 冷却并切换到池内其他可用账号。

| 文件 | 作用 |
| --- | --- |
| `ghost.json` | 清单：`node` 工作进程、额外入口 `agy-acp.js`、`harnesses` 声明、设置页、常驻逻辑页 |
| `main.js` | 逻辑页：检测 agy、读取模型与模式，`PUT /harnesses` 发布可用状态与账号登录方式 |
| `worker.js` | Node 工作进程（json-rpc-stdio），提供 `detect`、`setCustomPath`、`listModels`、`account`、`accountStatus`、`accountLogin`、`accountLoginCancel`、`login`、`cancelLogin`、`logout`、`usage` |
| `resolve-agy.js` | 查找与启动 agy 的共用代码（worker 与 ACP 入口用同一套自定义路径、查找顺序、参数与账号目录环境） |
| `agy-account-dir.js` | Cindy 新增账号目录的校验与路径布局（`.gemini/antigravity-cli`） |
| `agy-account-errors.js` | 为因账号/额度/繁忙失败的 ACP 会话与轮次回包补上 `error.data._meta.cindy` |
| `agy-client.js` | 插件自用的短时 ACP 连接（启动 agy、`initialize`、调用、停止） |
| `agy-models.js` | 经 ACP 读取模型、每个模型的思考深度、agy 的工作模式与订阅档位 |
| `agy-account.js` | 经 ACP 查询登录状态、从 agy 的日志读出账号邮箱、用 Google 登录、取消登录（支持原有登录与独立账号目录） |
| `agy-acp.js` | ACP 引擎入口：处理 `--cindy-account-dir`、启动 `agy acp`，双向转发 ACP，支持插话与错误分类 |
| `remote-workspace.js` | 任务文件在另一台电脑时：受限 Agent 的定义、两段式启动、账号目录透传，以及读懂 ACP 的转接 |
| `settings.html` / `settings.js` | 设置页：检测结果、版本、位置、自定义路径、安装提示、到模型供应商管理账号的引导与「重新检测」 |
| `locales/` | 清单名称与说明的英文、简体中文文案 |
| `test/bridge.test.mjs` | 用假 agy 验证检测、自定义路径、转发、参数与发布（`node --test test/bridge.test.mjs`） |

## 检测规则

若用户在设置页填写了自定义路径（保存在本机配置目录的 `cindy-agy-acp/config.json`，插件升级后保留），
检测、登录、模型探测、用量查询与任务执行一律使用该路径，不再回退到 `PATH`。留空时按默认顺序自动查找（取第一个找到的）：
`PATH` 中的 `agy` → Windows 的 `%LOCALAPPDATA%\agy\bin`（agy 1.5.12 实测位置）→
`~/.npmrc` 的全局目录与常见全局安装位置（macOS / Linux 含 `~/.agy/bin`、`~/.local/bin`、`/usr/local/bin`、
`/opt/homebrew/bin`）。找到后运行 `agy --version`（10 秒超时）：能运行发布「可用」及版本，找不到发布
`not-installed`，运行失败发布 `not-runnable`；读取模型时 agy 要求登录则发布 `not-signed-in`。发布给 Cindy 的
只有状态、原因、提示、版本、模型与模式，不含路径或命令。

## 插话

支持插话的 Cindy 客户端可在本机 Antigravity CLI 1.5.0 或更新的 1.x 正式版任务运行中追加消息。插件将插话转成并发 ACP prompt，并保持原任务运行到最后一条回复结束。远程工作区仍按顺序排队。

## 发布新版本

1. 修改 `ghost.json` 的 `version`（例如 `0.1.1`）。
2. 在 Cindy 里让 Agent 调用 `ghost_forge_pack` 打包，得到 `agy-acp-<版本>.cindy`。
3. 创建 GitHub Release，标签必须是 `v<版本>`（与清单版本一致），附件为上一步的 `.cindy`：

   ```sh
   gh release create v0.1.1 agy-acp-0.1.1.cindy --title "v0.1.1" --notes "…"
   ```

   草稿不会被检测到；预发布会在设置页标注。

## 测试

不需要真的安装 agy：

```sh
node --test test/bridge.test.mjs
```

## 已知限制

- macOS / Linux 上 agy 的默认安装位置未实机验证；不在上述位置时，可以在插件设置页配置自定义 `agy` 路径，或把 `agy` 所在目录加进 PATH。
- 未登录在读取模型（Cindy 启动、打开模型选择器）或打开设置页时发现；在终端里登出后，Cindy 要到下次检查才知道。
- 只提供 Google 个人账号登录；agy 公布的 Gemini Enterprise、Gemini API Key（按量计费）、Agent Platform 登录方式没有接入。
- agy 在任务中自己切换模式时（例如规划结束后），Cindy 的权限菜单不会跟着变。
- Cindy 给插件 Node 进程的环境变量是精简过的，只写在 shell 配置里的代理等变量不会传给 agy。
- 插件图标取自 Antigravity 官网（antigravity.google/assets/image/antigravity-logo.png），标志归 Google 所有。
