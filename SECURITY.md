# 安全说明

## 设计上的边界

- **登录口令**：全站（除 `/api/health`）都要登录；口令在 `config.json` 的 `auth.password`，首次启动随机生成。
- **公网暴露**：默认监听 `0.0.0.0`，但**必须配强口令**再用隧道/反代暴露。建议只映射到单个端口，不要映射 `data/`。
- **危险操作限本机**：
  - `POST /api/settings/autostart`（开机自启）只接受**本机回环**请求，带 `x-forwarded-for` 的一律拒绝；
  - `POST /api/shutdown`（服务自杀）只接受本机 + `auth.apiKey`。
- **密钥存储**：连接里的 `apiKey` 存在 `config.json`（明文，和多数本地工具一致）。`/api/connections` 只返回掩码和尾号，绝不回明文。
- **不代理任意 URL**：只按连接里配置的 Base URL 发请求，没有"任意转发"接口。

## 不要提交的东西

`config.json`、`data/`、`logs/`、`state.json` 已在 `.gitignore` 里。如果你 fork 后发现这些文件被跟踪：

```bash
git rm --cached config.json
```

## 报告漏洞

请开一个 **private security advisory**（或直接邮件联系维护者），不要开公开 issue。
请附：复现步骤、影响范围、你的环境（系统 / Node 版本）、可能的修复建议。
