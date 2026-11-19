# DSH-YCFW

> 通用对话网页端：把**本地部署的 AI**（会话型接口）或**任意 OpenAI 兼容服务**变成手机 / 另一台电脑上能用的聊天页。
> 页面（连接）可以手动添加，走标准接口；登录后自启、无窗口后台运行都可以配。

**English TL;DR** — A small, dependency-free web front-end for a self-hosted AI (session-style harness API)
or any OpenAI-compatible endpoint: page-per-connection, per-connection sessions, optional login, optional
auto-start on Windows, optional conversation backup, `npm start` out of the box. Node ≥ 18, zero npm dependencies.

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能](#功能)
- [快速开始](#快速开始)
- [页面（连接）](#页面连接)
- [自启动](#自启动)
- [配置](#配置)
- [HTTP 接口](#http-接口)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [备份对话数据](#备份对话数据)
- [外网访问](#外网访问)
- [常见问题](#常见问题)
- [贡献 / 安全 / 变更记录](#贡献--安全--变更记录)
- [许可](#许可)

## 它解决什么问题

- 想在**手机**上用自己的 AI，但不想装 App、不想把 API Key 交给第三方；
- 想让**多个 AI**（电脑端 DSH、本机 llama.cpp、Ollama、LM Studio、云端 DeepSeek……）**并存**，随时切换；
- 想让它**登录就自动在后台跑**，又能**一条命令手动启动**。

## 功能

- **两种连接类型，都是标准接口**
  - `dsh`：DSH 会话型服务 —— 0.1.x 网页版（`/api/session.list`，SSE 实时）与
    0.2.x / 桌面软件（Remote API；同机自动用本机凭据签 Cookie，远程可用令牌；
    1.5 秒轮询补齐）
  - `openai`：`GET {base}/models` + `POST {base}/chat/completions`（流式），覆盖 llama.cpp / Ollama / LM Studio / 云端
- **页面即连接**：地址自己填、想加就加、想删就删（删光后引导"＋ 添加"）；每个页面的会话各存各的
- **会话管理**：重命名、归档、取消归档、删除；DSH 的删除 = 归档（日志保留），状态与 DSH 双向同步
- **添加前可测**：会话型会区分 0.1/0.2 并给出令牌提示；OpenAI 兼容先 `/models` 再打一条最小对话
- **登录口令**：公网暴露时聊天内容不会裸奔（口令自动生成，见 `config.json`）
- **备份提取**：快照打 ZIP 下载，登录口令之外再加一层**部署端密码**
- **手机友好**：PWA，可"添加到主屏幕"
- **零依赖**：只用 Node 内置模块，`npm i` 不需要装任何东西
- **可选的 Windows 后台服务**：隐藏窗口、开机自启

## 快速开始

```bash
git clone https://github.com/<your-account>/dsh-ycfw.git && cd dsh-ycfw
npm start
```

起来后会自动打开 <http://127.0.0.1:8100/>，登录口令在 `config.json` 的 `auth.password`（首次启动自动生成）。

```bash
npm start -- --port 8200      # 换端口
npm start -- --no-open        # 只起服务，不自动开浏览器
npm start -- --home D:\data   # 配置/会话放到指定目录
npm i -g . && dsh-ycfw        # 全局安装后任意目录可用
```

数据目录优先级：`--home` > 环境变量 `DSH_YCFW_HOME` > 程序目录（可写时）> `~/.dsh-ycfw`。
所以 `npm i -g` 装到只读目录也不会报权限错误。

### 后台常驻（只有一个入口）

```bash
npm run stop         # 停掉正在跑的那份（调 /api/shutdown，只认本机 + apiKey）
npm run status       # 看跑没跑、自启开没开
npm run autostart:on # 开启登录自启（Windows 计划任务，后台无窗口）
npm run autostart:off
```

网页里的 **设置 → 自启动** 和上面的 `autostart:*` 是同一条路径（都调 `bin/dsh-ycfw.mjs autostart`），
所以不需要额外的控制台程序或 PowerShell 脚本。

## 页面（连接）

| 类型 | 用的接口 | 说明 |
|---|---|---|
| `dsh`（0.1.x 网页版） | `POST /api/session.*` + `/api/events.mux` | 与 `dsh web` 共用会话；地址一般 `http://127.0.0.1:3080`，不需要令牌 |
| `dsh`（0.2.x / 桌面软件） | `POST /api/session/*`、`workspace/follow` | 需要这次启动的 `?token=`（换一次 Cookie，存 30 天）；地址每次启动可能变，可勾「自动跟随日志」 |
| `openai` | `GET {base}/models`、`POST {base}/chat/completions` | 只要兼容这两条就能接：llama.cpp、Ollama、LM Studio、DeepSeek、OpenAI… |

添加流程：**抽屉 →「＋ 添加」→ 选类型 → 填服务地址 / 令牌 / API Key / 模型名 →「测试连接」→ 保存**。
会话型页面点「检测本机 DSH」会自动找本机端口和日志里的启动令牌。
编辑页面点列表项右侧的「编辑」；点页面本身是切换。

### 连 DSH 桌面软件（0.2.x）

桌面软件每次启动会随机一个端口和一个令牌，令牌只在它自己的启动输出里打印一次。
正常双击启动，这段输出没人接住。**同机部署不需要令牌、也不用重启桌面软件**：

1. 网页端「＋ 添加 → 会话型服务 → 检测本机 DSH」；
2. 它会扫描 `DeepSeek Harness.exe` 正在监听的 loopback 端口，读取
   `~/.dsh/.credentials.yaml` 里的浏览器会话密钥，在**本机**签一个 30 天的
   `dsh-auth` Cookie（密钥只在本进程内存里用，不回传、不写日志）；
3. 勾选「使用本机 DSH 凭据自动登录（仅本机）」→「测试连接」→ 保存；
4. 勾选「桌面软件重启后自动跟随日志/端口」，以后桌面软件换端口，网页端 20 秒内自动换过去。

如果 YCFW 不在桌面软件同一台机器，或者读不到本机凭据，才需要令牌：

```bash
# 先从托盘完全退出桌面软件，再用带日志的启动器启动（路径按实际改）
node tools/启动DSH桌面.mjs "C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"
```

它会把 `?token=` 启动地址写到 `~/.dsh/logs/dsh-desktop.out.log`，再点「检测本机 DSH」即可。

> 安全边界：`/api/dsh/discover`、开启/修改「本机凭据登录」、以及本机凭据登录的测试，
> **只接受部署端回环请求**（手机/别的电脑会收到 403）。已经配好的页面仍可由远程登录用户正常聊天。

> 桌面软件的 0.2.x Remote API 没有 SSE 事件流可复用（要 `/api/remote.mux` 的逻辑流），
> 网页端用 1.5 秒一次的历史轮询补齐；0.1.x 网页版仍然是实时 SSE。

常见 Base URL：

| 服务 | Base URL | 备注 |
|---|---|---|
| 本机 llama.cpp（llama-server） | `http://127.0.0.1:8080/v1` | llama-server 默认端口，按实际改 |
| Ollama | `http://127.0.0.1:11434/v1` | 模型名用 `ollama list` 里的 |
| LM Studio | `http://127.0.0.1:1234/v1` | |
| DeepSeek | `https://api.deepseek.com/v1` | 需要 API Key |

## 自启动

网页端由 `npm start` 常驻；每个页面的上游各自显示在线/离线，不会因为某一个上游停机就把整站停掉。
设置页（抽屉 → 设置 → 自启动）里可以：

- 开关「随系统登录自动启动」（Windows 计划任务，只有本机能操作）；
- 看手动启动命令（默认 `npm start`）。

## 配置

配置文件：数据目录下的 `config.json`（首次启动自动生成）。模板见 [`config.example.json`](config.example.json)。

```jsonc
{
  "port": 8100,
  "host": "0.0.0.0",              // 0.0.0.0 = 局域网/隧道都能访问
  "auth": { "password": "...", "sessionDays": 30, "apiKey": "..." },
  "dsh": { "baseUrl": "", "defaultCwd": "", "newSessionPreset": "" },
  "local": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "local", "maxTokens": 4096, "temperature": 0.7 },
  "connections": [                // 页面（连接）；留空 = 纯净部署，自己「＋ 添加」
    { "id": "c1", "name": "本机模型", "kind": "openai", "baseUrl": "http://127.0.0.1:8080/v1", "apiKey": "sk-...", "model": "qwen3-8b", "autoOpen": true },
    // 0.1.x 网页版：不用令牌
    { "id": "c2", "name": "DSH 网页版", "kind": "dsh", "baseUrl": "http://127.0.0.1:3080", "api": "legacy" },
    // 0.2.x / 桌面软件：令牌只用于换 Cookie，换完可以删；autoDesktop 让它跟随日志换端口
    { "id": "c3", "name": "DSH 桌面", "kind": "dsh", "baseUrl": "http://127.0.0.1:56918",  // 端口按实际
      "api": "dsh2", "token": "本次启动的令牌", "cookie": "dsh-auth-...=v1...", "autoDesktop": true }
  ],
  "ui": { "appName": "AI 对话", "publicUrl": "" }
}
```

`config.json` **含口令和密钥，已在 `.gitignore` 里，别提交**。

环境变量：`DSH_YCFW_HOME`（数据目录）、`DSH_YCFW_APIKEY_FILE`（上游密钥文件）、`MC_PORT` / `MC_HOST`（覆盖端口/监听地址）。

## HTTP 接口

全部要登录（Cookie 或 `Authorization: Bearer <auth.apiKey>`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` `/api/logout` | 登录 / 退出 |
| GET | `/api/health` | 健康检查（不需要登录，只回连接状态） |
| GET | `/api/me` | 当前用户、连接列表、上游状态 |
| GET/POST | `/api/connections` | 列页面 / 添加页面 |
| PATCH/DELETE | `/api/connections/{id}` | 改 / 删页面 |
| POST | `/api/connections/test`、`/api/connections/{id}/test` | 测连接（未保存 / 已保存） |
| GET/POST | `/api/conn/{id}/conversations` | 该页面的会话列表 / 新建 |
| GET/PATCH/DELETE | `/api/conn/{id}/conversations/{cid}` | 单个会话 |
| POST | `/api/conn/{id}/chat` `/api/conn/{id}/stop` | 发消息 / 停止生成 |
| GET | `/api/dsh/discover` | 找本机 DSH 的地址 / 日志里的令牌 |
| GET/POST | `/api/dsh/sessions` | 会话列表 / 新建；用 `X-DSH-Conn: <页面 id>` 指定是哪个会话型页面 |
| GET | `/api/dsh/sessions/{id}/history` | 历史（分页） |
| POST | `/api/dsh/sessions/{id}/prompt` `/cancel` `/rename` `/archive` `/unarchive` | 发消息 / 停止 / 改名 / 归档 / 取消归档 |
| DELETE | `/api/dsh/sessions/{id}` | 删除 = 归档（DSH 没有删除会话的接口） |
| GET | `/api/dsh/archived` | 已归档会话列表 |
| GET | `/api/events` | SSE：多端实时同步 |
| GET/PUT | `/api/settings` | 设置 |
| POST | `/api/settings/autostart` | 开关开机自启（仅本机 + Windows） |
| POST | `/api/shutdown` | 让服务自己退出（仅本机 + apiKey） |

`/api/local/*` 作为兼容路径保留，自动映射到"第一条 openai 连接"。

## 目录结构

```
DSH-YCFW/
├─ bin/dsh-ycfw.mjs       启动器（npm bin）：定位数据目录 → 起服务 → 开浏览器
├─ server/
│   ├─ server.mjs         服务端（零依赖）
│   ├─ lib/dsh.mjs        DSH 0.1.x 客户端（REST + SSE 多路复用）
│   ├─ lib/dsh2.mjs       DSH 0.2.x / 桌面软件客户端（Remote API + 令牌换 Cookie + 轮询）
│   ├─ lib/dsh-local-auth.mjs  本机 DSH 凭据自动登录（仅 loopback）
│   ├─ lib/ws.mjs         极简 WebSocket 客户端（读 workspace/follow 基线）
│   ├─ lib/zip.mjs        零依赖 ZIP 写入（备份下载）
│   ├─ lib/store.mjs      会话存储 + 流式转发（每个 openai 连接一个实例）
│   └─ web/               前端（index.html / app.js / style.css / sw.js / icons）

├─ tools/                 测试工具 + 启动DSH桌面.mjs（带日志启动桌面软件）
├─ scripts/               构建/打包（build-dist.mjs：生成纯净部署包并做泄露检查）
├─ .github/workflows/     CI（node --check + 接口测试）
├─ config.example.json    配置模板
└─ data/ logs/ state.json 运行期数据（已在 .gitignore）
```

## 开发与测试

```bash
npm run serve                      # 后台式启动（不开浏览器）
node tools/测试接口.mjs            # 接口层：登录/连接增删/测试/对话/自启动（自带假上游 + 临时目录）
node scripts/build-dist.mjs        # 打纯净部署包 dist/ 并做「无本机信息」检查
node tools/烟测-设置与删除.mjs      # 无头 Chrome：设置面板 + 删除页面（需要服务已在跑）
node tools/烟测页面.mjs             # 无头 Chrome：添加页面 → 对话 → 编辑（自带假上游）
node tools/启动DSH桌面.mjs "…\\DeepSeek Harness.exe"  # 带日志启动桌面软件（让网页端能读到令牌）
```

（没有需要编译的东西：前端是原生 JS，后端零依赖。）



## 备份对话数据

对话（会话记录、页面连接）可以定时自动备份，也可以手动触发。**改备份设置**属于部署端能力，
**导出记录**多一层部署端密码：

- 改设置 / 立即备份：只认**本机回环**来源；
- 非部署端（手机/别的电脑）的设置页**不显示备份设置和部署端密码框**，只有一个「导出记录」；
  点它才弹出密码输入，密码正确才下载 ZIP；`/api/settings` 也不会把备份目录/间隔返回给非部署端；
- 下载快照：任意已登录设备 + **部署端密码**（登录口令之外的额外一层，第一次设置至少 8 位，
  `scrypt` 加盐散列存储）；手机也知道密码就能导；
- 限制：备份目录必须是绝对路径、不能是盘根、不能落在 `data/` 或 `logs/` 里；间隔 1~168 小时；保留 1~200 份；
- 备份内容：`data/`（会话与连接）+ 脱敏后的配置副本（口令与密钥已被抹掉）；
- 轮转只清理备份目录内形如 `snapshot-*` 的自家快照。

界面：**抽屉底部「备份」→ 设置 → 备份（对话数据）**；部署端可改设置，快照有「导出」按钮（打 ZIP）；
非部署端看到的是「导出记录」，输入部署端密码后导出。等价接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/backup` | 备份状态与快照列表（登录即可看，不含任何密钥） |
| POST | `/api/backup/config` | 改备份设置 / 设部署端密码（本机回环 + 部署端密码） |
| POST | `/api/backup/run` | 立即备份（本机回环 + 部署端密码） |
| POST | `/api/backup/download` | 下载快照 ZIP（登录 + 部署端密码；`{password, name}`，name 省略 = 最新） |

## 外网访问

先记住一点：**`ui.publicUrl` 只是"记录 + 自检"用的地址，填了它不会自动开通外网**。
外网能不能打开，取决于你有没有一条隧道/端口映射把公网地址转到本机 `8100`。

- `host=127.0.0.1`（默认）：只有本机能打开；
- `host=0.0.0.0`：局域网可访问，隧道/反向代理也才能接进来；
- 改监听地址或端口后**需要重启服务**才生效。

**内网穿透怎么做**（任选一种，目标都指向 `http://127.0.0.1:8100`）：

1. **Tailscale Funnel**（本机已在用）：
   ```bash
   tailscale funnel --bg --set-path /chat http://127.0.0.1:8100
   ```
   外网地址就是 `https://<机器名>.<tailnet>.ts.net/chat/`；
2. **frp / natapp / 花生壳**：在服务端把本地端口设为 `8100`，拿到公网域名；
3. **Cloudflare Tunnel**：`cloudflared tunnel --url http://127.0.0.1:8100`，用给出的域名；
4. 有公网 IP：路由器端口映射 + 反向代理（建议 HTTPS）。

如果隧道给的是**子路径**（如 `https://域名/chat/`），隧道/反代要**把 `/chat` 前缀去掉**再转给
`127.0.0.1:8100`（nginx 的 `proxy_pass http://127.0.0.1:8100/;` 末尾带斜杠），否则会 404。
Tailscale Funnel 的 `--set-path` 会自动处理。

**设置 → 外网访问 → 开始自检**（`GET /api/net/check`）会告诉你：监听范围、局域网地址、域名是否解析、
外网地址是否真的能打开、**本机检测到的隧道地址**（Tailscale Funnel）以及缺什么。
检测到的隧道地址会显示成一排按钮，点一下就能填入 `ui.publicUrl`。

## 常见问题

- **页面打开是空白 / 一直登录中** → 看 `logs/server.log`；多半是端口被占或 `config.json` 坏了（删掉会重新生成，但口令会变）。
- **本地模型页一直"离线"** → 上游没跑或 Base URL 不对，去「编辑页面 → 测试连接」看具体报错。
- **`npm start` 报 EADDRINUSE / 端口 8100 被占用** → 本机已经有一个实例在跑（多半是后台服务/计划任务）。
  `npm start` 会自动识别这种情况，直接告诉你"已经在跑"并打开浏览器；要另起一个就 `--port 8200`；
  要停后台那个用 `npm run stop`。
- **`npm start` 起来后很快没了** → 检查是否有第二份进程在管端口；先 `npm run stop` 再试。
- **公网怎么开** → 用 Tailscale Funnel / frp / natapp / Cloudflare Tunnel 把 8100 映射出去，
  再把隧道实际给出的地址填进 `ui.publicUrl`（或点「检测到的隧道地址」一键填入）；记得设置强口令。
- **填了外网网址还是打不开** → 先看域名是否解析（`Resolve-DnsName 域名`）；`https://example.com/chat/`
  这种没有 DNS 记录/拼错的地址打不开。其次确认隧道目标是不是 `127.0.0.1:8100`，
  子路径有没有把前缀去掉。

## 贡献 / 安全 / 变更记录

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全策略（如何报告漏洞）：[SECURITY.md](SECURITY.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

## 许可

[MIT](LICENSE)
