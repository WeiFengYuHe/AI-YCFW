# 贡献指南

## 开发环境

- Node.js ≥ 18（用到了内置 `fetch`、`TextDecoder`）
- 没有任何构建步骤、没有 npm 依赖

```bash
npm start          # 起服务（自动开浏览器）
npm run serve      # 起服务，不开浏览器
```

## 代码约定

- 只用 **Node 内置模块**，不要引入 npm 依赖（这个项目卖点之一就是零依赖）。
- 服务端在 `server/server.mjs`，前端在 `server/web/`；前端是原生 JS，没有构建步骤。
- 中文注释可以写，但**对外接口字段名用英文**（`connections` / `kind` / `baseUrl` / `model`…）。
- 新增连接类型时：改 `normalizeConn` / `publicConn` / `testConnection` 三处，以及前端的类型选择。
- 修改 `server.mjs` 后请确保 `node --check server/server.mjs` 通过、`node --check server/web/app.js` 通过。

## 提交前自测

```bash
node --check server/server.mjs
node --check server/web/app.js
node tools/烟测-设置与删除.mjs      # 需要服务已启动
```

Windows 上完整跑一遍：

```bash
node tools/测试接口.mjs        # 临时数据目录 + 假上游：登录/连接增删/对话/自启动
node tools/烟测-设置与删除.mjs # 无头 Chrome：设置面板 + 删除页面（需要 8100 在跑）
node tools/烟测页面.mjs        # 无头 Chrome：添加页面 → 对话 → 编辑（自带假上游）
```

## 提交信息

用祈使句、说清楚"改了什么 + 为什么"：

```
fix: 删光页面后又冒出来（空数组被当成没配置）
feat: 页面可以设「启动时默认打开」
```

## 提 PR 之前

- 不要提交 `config.json`、`data/`、`logs/`（已在 `.gitignore`）。
- 涉及安全的行为（自启动、关机接口）必须保持"仅本机 + 需要 apiKey"的限制。
