# Leak Scan 部署操作

本文档按 `E:\cloudfareworker\Cloud-Vault` 的部署方式整理：使用 Wrangler 部署一个 Cloudflare Worker，Worker 同时托管前端静态资源和后端 API。

## 0. 准备

本地要求：

- Node.js 20+
- npm
- Cloudflare 账号
- Wrangler 登录权限

进入项目：

```powershell
cd E:\cloudfareworker\cloud-scaner
cmd /c npm install
cmd /c npx wrangler login
```

## 1. 创建 D1 数据库

```powershell
cmd /c node_modules\.bin\wrangler.cmd d1 create leak-scan
```

命令会输出类似配置：

```toml
[[d1_databases]]
binding = "DB"
database_name = "leak-scan"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把 `database_id` 写入 [worker/wrangler.toml](worker/wrangler.toml)：

```toml
[[d1_databases]]
binding = "DB"
database_name = "leak-scan"
database_id = "你的 D1 database_id"
preview_database_id = "local-leak-scan"
migrations_dir = "migrations"
```

## 2. 创建 KV 命名空间

```powershell
cmd /c node_modules\.bin\wrangler.cmd kv namespace create SCAN_KV
```

命令会输出类似配置：

```toml
[[kv_namespaces]]
binding = "SCAN_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

把 `id` 写入 [worker/wrangler.toml](worker/wrangler.toml)：

```toml
[[kv_namespaces]]
binding = "SCAN_KV"
id = "你的 KV namespace id"
```

## 3. 配置生产密钥

生产环境至少配置这几个：

```powershell
cd E:\cloudfareworker\cloud-scaner\worker
cmd /c npx wrangler secret put JWT_SECRET
cmd /c npx wrangler secret put ADMIN_EMAIL
cmd /c npx wrangler secret put ADMIN_PASSWORD
```

建议：

| 变量 | 类型 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | Secret | JWT 签名密钥，使用长随机字符串 |
| `ADMIN_EMAIL` | Secret 或 Variable | 初始管理员邮箱 |
| `ADMIN_PASSWORD` | Secret | 初始管理员密码 |

不要在生产环境使用默认管理员密码 `admin123`。

GitHub Token 不需要在部署时写入环境变量。部署完成后登录系统，在“设置”页添加一个或多个 GitHub Personal Access Token。

## 4. 执行远程 D1 迁移

```powershell
cd E:\cloudfareworker\cloud-scaner
cmd /c node_modules\.bin\wrangler.cmd d1 migrations apply leak-scan --remote --config worker\wrangler.toml
```

如果提示缺少 `database_id`，说明 [worker/wrangler.toml](worker/wrangler.toml) 还没有写入 D1 的真实 ID。

## 5. 构建并部署 Worker

```powershell
cd E:\cloudfareworker\cloud-scaner
cmd /c npm --workspace worker run deploy
```

这个命令会执行：

1. 根目录 `npm run build`
2. 前端构建到 `frontend/dist`
3. Worker TypeScript 类型检查
4. `wrangler deploy`

部署成功后，Wrangler 会输出 Worker 地址，例如：

```text
https://leak-scan.<你的账号>.workers.dev
```

## 6. 初始化管理员

登录页会在首次登录时自动确保默认管理员存在。也可以手动初始化：

```powershell
curl -X POST https://你的域名/api/init/
```

然后使用你设置的：

| 字段 | 来源 |
| --- | --- |
| 邮箱 | `ADMIN_EMAIL` |
| 密码 | `ADMIN_PASSWORD` |

登录后到“设置”页添加 GitHub Token，再开始扫描。

## 7. 更新部署

代码更新后：

```powershell
cd E:\cloudfareworker\cloud-scaner
cmd /c npm run typecheck
cmd /c npm --workspace worker run deploy
```

如果有新的数据库迁移文件，先执行：

```powershell
cmd /c node_modules\.bin\wrangler.cmd d1 migrations apply leak-scan --remote --config worker\wrangler.toml
```

## 8. 常见问题

### 发现列表为空，但扫描日志里有发现

先确认后端接口是否返回数据：

```powershell
cmd /c node_modules\.bin\wrangler.cmd d1 execute leak-scan --remote --command "SELECT id, scan_id, rule_name FROM findings ORDER BY created_at DESC LIMIT 10"
```

### 扫描失败：未添加 GitHub Token

登录系统后进入“设置”，添加 GitHub Personal Access Token。

### Wrangler 提示没有 D1 或 KV 绑定

检查 [worker/wrangler.toml](worker/wrangler.toml) 是否已经写入：

- D1 的 `database_id`
- KV 的 `id`

### 登录后接口 401

确认 `JWT_SECRET` 已设置，并且部署后没有频繁更换。更换 `JWT_SECRET` 会让旧 token 全部失效，需要重新登录。
