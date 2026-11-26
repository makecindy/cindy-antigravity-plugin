# Antigravity 插件（agy-acp）

在 Cindy 打开 Antigravity 插件设置，可检测本机 CLI、从 Google 官方发布源安装及检查更新。已有自定义安装位置时，更新交给该 Antigravity CLI 的原生更新命令，它的输出也会进入安装日志。安装或更新时，设置页显示当前步骤、已用时间，下载时显示进度、速度和剩余时间；可展开的安装日志列出每一步和安装程序的输出（用户目录显示为 ~，凭据会被隐去）。日志只保存在插件运行期间，重新打开设置页也能看到。

从旧版升级时，请从新仓库下载 .cindy 文件并在 Cindy 导入一次，之后插件更新将使用 makecindy 下的新地址。

把本机已安装、已用 Google 账号登录的 Google Antigravity 命令行（`agy`）作为 Cindy 的任务执行引擎。
插件通过清单的 `harnesses` 字段声明一个 ACP 引擎，Cindy 在模型选择器里显示「Antigravity」，
选中后每个任务启动一个 `agy acp` 进程，用 [Agent Client Protocol](https://agentclientprotocol.com) v1
与它对话。

插件负责「找到 agy、报告能不能用、列出 agy 提供的模型、思考深度与工作模式、在设置页登录 / 退出、
把字节原样转发」。它不安装、不分发 agy，也不接触任何账号凭证：登录由 agy 自己管理。

## 安装与更新

1. 从本仓库的 [Releases](https://github.com/makecindy/cindy-antigravity-plugin/releases) 下载最新的
   `agy-acp-<版本>.cindy`，在 Cindy 的插件页导入。安装确认会列出 Node 工作进程（本机权限）和
   「提供执行引擎 Antigravity」两项权限。
2. 之后在插件设置页的宿主区域即可检查并安装新版本：清单里的 `githubRelease` 指向本仓库，
   Cindy 读取 GitHub Release、校验附件摘要后走插件更新确认，启用状态、配置与数据保持不变。
3. 需要支持插件执行引擎的 Cindy，见下方「前提条件」。

## 账号用量

设置页显示当前 Google 账号各模型组的剩余额度和重置时间。数据来自本机 agy 的原生 `/usage` 命令，查询不会发起模型对话。支持插件用量的 Cindy 也会在使用此引擎的任务输入框下方显示用量，点击可看明细。旁边的圆环显示当前任务由引擎上报的上下文占用。额度周期能明确识别时（如 `5h`、`weekly`），用量里会一并带上窗口时长（`windowMinutes`），供 Cindy 判断哪份额度更快重置；认不出的周期不带。

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
   `%LOCALAPPDATA%\agy\bin\agy.exe`，不需要加进 PATH。登录可以在插件设置页完成（见下），也可以在终端运行 `agy`。

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

打开模型选择器时 Cindy 会请插件刷新（同一插件 10 分钟内最多一次）。agy 没有登录时，引擎显示为不可用，
提示到插件设置页登录。

## 账号：登录与退出

插件设置页的「账号」区域经 ACP 操作 agy 自己的登录（agy 1.5.12 实测）：

- **状态**：打开设置页或点「重新检测」时检查 agy 是否已登录，并显示 agy 报告的订阅档位（例如 Google AI Pro）。
  拿不到登录邮箱：ACP 不提供，插件也不读 agy 的凭证或日志。
- **用 Google 登录**：发 `authenticate`（`oauth-personal`），agy 自己打开浏览器走 Google 登录，完成后返回；
  最多等 5 分钟，等待期间可以「取消登录」（结束这次的 agy 进程）。登录成功后立即恢复引擎并重新读取模型。
- **退出登录**：先在页面上确认，再发 `logout`。agy 的 `logout` 不校验参数、一调用就登出，所以插件只在确认后发送。
  退出后 Cindy 里的 Antigravity 和终端里的 agy 都需要重新登录。

登录信息由 agy 保存在它自己的存储里（Windows 上是系统凭据管理器），插件与 Cindy 都不保存。

支持引擎账号的 Cindy 会在 Antigravity 引擎下显示当前登录的订阅档位（例如 Google AI Ultra）。插件只上报
这一个登录（`accountStatus`：是否已登录与订阅档位，读法同上面的「状态」，复用模型探测会话，不新建会话），同样不含
邮箱。**不支持在 Cindy 里添加多个 Antigravity 账号**：agy 把 Google 登录存在系统凭据存储的固定位置，一台电脑只有
一个登录，换 HOME 等目录也还是同一个账号（agy 1.5.14 实测），agy 本身也不支持多个 Google 账号。要换账号，请在
设置页退出后用另一个 Google 账号登录。

| 文件 | 作用 |
| --- | --- |
| `ghost.json` | 清单：`node` 工作进程、额外入口 `agy-acp.js`、`harnesses` 声明、设置页、常驻逻辑页 |
| `main.js` | 逻辑页：检测 agy、读取模型与模式，`PUT /harnesses` 发布可用状态 |
| `worker.js` | Node 工作进程（json-rpc-stdio），提供 `detect`、`setCustomPath`、`listModels`、`account`、`accountStatus`、`login`、`cancelLogin`、`logout`、`usage` |
| `resolve-agy.js` | 查找与启动 agy 的共用代码（worker 与 ACP 入口用同一套自定义路径、查找顺序与参数） |
| `agy-client.js` | 插件自用的短时 ACP 连接（启动 agy、`initialize`、调用、停止） |
| `agy-models.js` | 经 ACP 读取模型、每个模型的思考深度、agy 的工作模式与订阅档位 |
| `agy-account.js` | 经 ACP 查询登录状态、用 Google 登录、取消登录、退出登录 |
| `agy-acp.js` | ACP 引擎入口：启动 `agy acp`，双向转发 ACP，支持插话时转换请求 |
| `remote-workspace.js` | 任务文件在另一台电脑时：受限 Agent 的定义、两段式启动，以及读懂 ACP 的转接 |
| `settings.html` / `settings.js` | 设置页：检测结果、版本、位置、自定义路径、安装提示、账号（登录 / 退出）与「重新检测」 |
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

支持插话的 Cindy 客户端可在 Antigravity CLI 1.5.0 或更新的 1.x 正式版任务运行中追加消息（本机任务与远程 / 分享工作区均适用）。插件将插话转成并发 ACP prompt，并保持原任务运行到最后一条回复结束。

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
