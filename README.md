# github-publisher

把 DSH 会话内容发布到 GitHub 的插件：对话框左下角一个按钮，正文取自本轮对话、可直接编辑，简介由当前会话的模型自动撰写。

一个 DeepSeek Harness（DSH）插件。它在对话框左下角加一个「发布 GitHub」按钮，把当前这一轮对话整理成正文，由会话模型写简介，然后作为一次提交推进你自己的 GitHub 仓库。

## 它能做什么

- **一键发布**：面板打开时把**整个会话**的记录（每一条我的要求和每一条回复，按顺序）填进正文，正文可以随意修改后再提交；会话很长时保留最后一部分，并在正文开头说明丢掉了多少条。
- **读取本地 txt**：面板上的「读取 txt 文件」按钮把选中的 `.txt` 直接变成正文，可以再手动编辑；超过 100 万字符会拒绝并说明原因，读取失败时保留原来的正文。
- **发布到哪里一目了然**：正文上方有「发布到仓库里的哪个文件」一栏，会话记录默认写进 `notes/<时间>-<会话号>.md`，读入 txt 时默认写进 `notes/<文件名>`；这栏可以改成任意路径，改成 `README.md` 时面板会提醒你这会覆盖项目自己的说明。
- **自动写简介**：不填简介时，由当前会话的模型写 commit message；模型不可用时退化为正文首行，发布本身不会因此失败。
- **发布后给两个入口**：github.com 的文件页，以及 jsDelivr 直链（国内可读，公开仓库下可用）。
- **顺带提供的宿主工具**：`github_account`（查连接和 token 来源）、`github_publish`（gist 或仓库提交）、`github_intro`（只写简介、不发布），这样在对话里也能直接发布。
- **新仓库默认私有**：按钮不会擅自替你公开任何东西，面板上的「公开仓库」勾选后才会公开。

## 安装

插件是一个标准的 DSH bundle，用 `plugin_manager` 安装这个目录即可（profile 的 patch 由安装器负责写入）：

```
plugin_manager action=install_bundle target=<this directory>
```

安装后需要重启 DSH：宿主一侧的模块由 Node 的 ESM 缓存加载，客户端一侧的 bundle 在启动时构建，重启后按钮才会出现。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `token` | 无 | 直接写 token；留空则按下面的顺序查找 |
| `owner` | 当前登录账号 | 目标仓库的 owner |
| `repo` | `ai-notes` | 默认目标仓库，不存在时自动创建 |
| `branch` | 仓库默认分支 | 提交到哪个分支 |
| `envFile` | 无 | 额外的 `.env` 文件路径 |
| `cdnHost` | `https://cdn.jsdelivr.net` | 直链用的 CDN 前缀 |
| `introProvider` / `introModel` | 会话默认模型 | 写简介用的模型路由 |
| `introMaxTokens` | `8000` | 简介的输出预算，必须容得下推理过程 |
| `timeoutMs` | `180000` | 单次发布的超时 |

token 的查找顺序：工具参数 → 插件配置 → `credentials` 服务（`GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_PAT`）→ 进程环境变量 → `envFile` → profile 目录下的 `.env`（`DSH_PROFILE_DIR`、`DSH_HOME`+profile、模块位置依次尝试）。

## token 权限

GitHub 细粒度 token 需要：

- **账户权限 → Gists**：只在用 gist 模式时需要；
- **存储库权限 → Contents：读取和写入**：提交文件的必要条件；
- **存储库权限 → Administration：读取和写入**：需要自动新建仓库时才要。

## 为什么默认发布到仓库，不是 Gist

代码两条路都支持（`target: "gist" | "repo"`），但默认是仓库：部分网络环境下 `gist.github.com` 无法访问，而 `github.com` 和 `api.github.com` 正常。仓库提交在所有环境下都能打开。

## 实现要点

- **宿主一半** `index.js`：注册三个工具，并在 `/github-publisher` 前缀下开三个同源 HTTP 路由（`GET /status`、`POST /publish`），客户端按钮直接 `fetch` 它们——声明式的客户端一半拿不到 `host.call`，同源路由是唯一不依赖模型回合的通道。
- **客户端一半** `client.js`：在 `conversation.input.left` 插槽注册一个带错误边界的 React 按钮（`window.__ModuleLoader__` 形式，只 `require("react")`），配色全部走 `--dsw-alias-*` 主题变量。
- **无第三方依赖**：运行时只用 Node 内置模块，不需要安装任何包。

## 已验证的行为

- `notes/github-publisher.md` 这样带目录的相对路径会落在正确位置，不会出现 `<path>/<path>` 这种嵌套；
- 目标路径已经存在（GitHub 返回目录列表）时，会替换该路径而不是发一个空的 `sha` 被 422 拒绝；
- 推理型模型路由（先输出 reasoning、再输出正文）的流能被正确收集，不会因为预算不足报 `MAX_TOKENS`。
