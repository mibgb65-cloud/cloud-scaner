# Leak Scan

Leak Scan 是一个部署在 Cloudflare Workers 上的 GitHub 密钥泄露扫描系统。它使用 Vue 作为前端，Hono Worker 作为 API，数据存储在 Cloudflare D1，扫描进度和短期缓存放在 Workers KV。

## 功能

- GitHub 代码搜索扫描
- 常见 API Key / Secret 规则识别
- OpenAI、DeepSeek、Google、Anthropic 等密钥验证
- GitHub Token 多账号轮换
- 扫描任务、发现列表、审计日志和规则库
- 明暗模式、开屏动画、站内确认弹窗

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 前端 | Vue 3, Vite, Pinia, Vue Router, Tailwind CSS |
| 后端 | Cloudflare Workers, Hono, TypeScript |
| 数据 | Cloudflare D1, Workers KV |
| 部署 | Wrangler, Worker Static Assets |

## 项目结构

```text
.
├── frontend/              # Vue 前端
├── worker/                # Cloudflare Worker API
│   ├── migrations/        # D1 数据库迁移
│   ├── src/               # Worker 源码
│   └── wrangler.toml      # Cloudflare 配置
├── DEPLOYMENT.md          # 部署操作文档
├── package.json           # workspace 脚本
└── package-lock.json
```

## 本地开发

要求：

- Node.js 20+
- npm

安装依赖：

```powershell
cd E:\cloudfareworker\cloud-scaner
cmd /c npm install
```

启动前端：

```powershell
cmd /c npm run dev:frontend
```

启动 Worker：

```powershell
cmd /c npm run dev:worker
```

默认地址：

- 前端：`http://127.0.0.1:5173`
- Worker：`http://127.0.0.1:8787`

本地默认管理员：

| 字段 | 默认值 |
| --- | --- |
| 邮箱 | `admin@leak-scan.local` |
| 密码 | `admin123` |

生产部署时必须改掉默认密码，见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 常用命令

```powershell
cmd /c npm run typecheck
cmd /c npm run build
cmd /c npm --workspace worker run deploy
```

## Cloudflare 部署

本项目采用和 `Cloud-Vault` 一样的单 Worker 部署方式：

1. 前端构建到 `frontend/dist`
2. Worker 通过 `[assets]` 托管前端静态资源
3. `/api/*` 请求由 Hono API 处理
4. D1 保存业务数据
5. KV 保存扫描进度、日志片段和登录会话

完整步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 生产注意事项

- 不要把 Cloudflare API Token、JWT 密钥、管理员密码提交到仓库。
- GitHub Token 不建议放在仓库或明文环境文件里，部署后在系统“设置”页添加。
- D1 的 `database_id` 不是密钥，但绑定到具体 Cloudflare 账号，换账号部署时必须替换。
- 扫描会调用 GitHub Search API，Token 权限和频率限制会影响扫描效果。
