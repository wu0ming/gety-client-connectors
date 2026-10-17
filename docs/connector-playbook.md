# 给本地 AI 客户端做 GetY 连接器：可复用经验

这份文档把 DeepSeek Harness（DSH）和 WorkBuddy 两个连接器的实现经验压缩成一套可复用的做法。目标不是“抄一个连接器”，而是遇到任何本地 AI 客户端时，能快速判断数据在哪、怎么稳定索引、怎么验证。

> TL;DR：先确认会话正文到底存在本地还是云端；只索引稳定、可重放的本地数据；一个会话一篇文档；用 mtime/size + 内容哈希做增量；永远不要把工具输出、reasoning、注入上下文和密钥写进索引；最后一定用真实的 `gety connector install/poll/search` 验证。

---

## 1. 先判断数据在哪

不要假设“AI 客户端都有 JSONL 会话日志”。先分三类：

| 类型 | 例子 | 可索引内容 |
| --- | --- | --- |
| 本地完整日志 | DSH `session.v4.jsonl.zstd`、Codex/Claude Code JSONL | 用户消息、助手回答、标题 |
| 本地索引 + 云端正文 | WorkBuddy `workbuddy.db` + 云端会话 | 标题、工作区、模型、状态；有本地 trace 时补正文 |
| 只有云端 | 某些 Web-first 客户端 | 只能索引元数据，或不做连接器 |

WorkBuddy 就是一个典型：`workbuddy.db` 保存会话标题、工作区和模型等元数据，但正文在云端；桌面端的 `traces/*.json` 只覆盖一部分运行。连接器必须诚实标注“这是元数据文档”，否则用户会以为搜索不到正文是 bug。

**结论：先写一个只读侦察脚本，确认可用字段和覆盖范围，再写连接器。**

---

## 2. 侦察清单

对目标客户端依次检查：

1. **安装目录**：Electron 的 `resources/app.asar`、Tauri 的 `resources/`。
2. **用户目录**：`~/.<client>`、`%APPDATA%/<client>`、`%LOCALAPPDATA%/<client>`。
3. **会话文件**：`sessions/`、`projects/`、`workspace/sessions/`、`*.jsonl`、`*.json`、`*.db`。
4. **数据库**：用只读方式打开，列出表名和行数；优先找 `sessions`、`messages`、`conversations`。
5. **trace/audit**：`traces/`、`audit-log/`、`logs/` 往往包含 agent 的完整 prompt 或工具调用。
6. **插件/MCP 配置**：判断客户端是否能“一键连接”，还是只能手动装 GetY 连接器。

只读原则：

```python
sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
```

Deno 里：

```ts
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(dbPath, { readOnly: true });
```

**不要**在侦察阶段写入、迁移或修复客户端数据。

---

## 3. 文档契约

GetY 的文档模型很小：`id`、`title`、`content`、`metadata`、`doc_type`、`doc_updated_at`、`doc_link`。

推荐约定：

- **一篇文档 = 一个会话**（或一个独立 trace，当无法归到会话时）。
- **ID 稳定**：会话 UUID / 文件相对路径；不要用行号、时间戳或标题。
- **标题**：客户端标题 → 第一条用户提问 → `Session <short-id>`。
- **正文**：只放用户消息和助手回答；轮次用 `---` 分隔；`### User` / `### <Client>`。
- **metadata**：`workspace`、`model`、`created_at`、`updated_at`、`messages`，加上客户端特有的状态。
- **doc_link**：优先用客户端会话目录的 `file://` 链接；没有稳定链接就省略，不要编造临时 URL。
- **`content_format: "markdown"`**，`doc_type: "<client>:session"`。

正文上限：单个文档约 10 MB，建议自己截断到 2 MB 并加说明。

---

## 4. 格式适配

### 4.1 多帧 zstd（DSH）

DSH 的 `session.v4.jsonl.zstd` 不是“一个 zstd 流”，而是**每个事件一个独立 frame**拼接。Node/Deno 的 zstd 流式解压只会读第一帧，然后报 `Unknown frame descriptor`。

解决：用纯 JS 的 `fzstd`，它的 `Decompress` 支持连续 frame：

```ts
const d = new Decompress((chunk) => parts.push(chunk.slice()));
d.push(bytes, true);
```

如果文件尾部正在写入，`push` 可能抛错；保留已经产出的 chunk，下一次轮询会因为 size 变化重试。

### 4.2 SQLite（WorkBuddy）

Deno 2.8 支持 `node:sqlite`，可以直接在 GetY 连接器里只读查询：

```ts
const rows = db.prepare(
  "select id, title, cwd, model from sessions where deleted_at is null or deleted_at = -1"
).all();
```

注意：

- 读取失败（升级、锁）时返回 `null`，**跳过本轮，不要删文档**。
- `deleted_at` 可能是 `null`、`-1` 或时间戳；只保留未删除的。
- `created_at` 可能是毫秒数或字符串；统一 `Number()` 后再转 RFC 3339。

### 4.3 Trace JSON（WorkBuddy）

WorkBuddy 的 `trace_*.json` 结构是 `{ trace, spans[] }`，其中 `generation` span 的 `toolInput` 是这一轮 LLM 看到的完整消息数组，`toolOutput` 是模型输出。

经验：

- 取**最后一个** `generation` span，它的消息历史最完整。
- `toolInput` 可能是字符串或数组，先 `parseMaybeJson`。
- 只保留 `role: user` / `role: assistant`；跳过 `system` / `tool`。
- 用户消息里真正的提问在 `<user_query>...</user_query>`；外层是 `system-reminder`、身份文件、记忆文件等注入内容。
- 过滤自动化提示（`You MUST follow these steps in order`、`automation_system_reminder`）和内部 JSON 控制消息（`{"isNewTopic": true, ...}`）。

---

## 5. 增量、删除与缓存

不要每轮重读所有数据。

### 5.1 文件指纹

state 里保存：

```ts
type FileState = { mtime_ms: number; size: number; indexed: boolean; session_id?: string };
```

只有 mtime/size 变化才重新解析。文件消失 → 删除对应文档。

### 5.2 内容哈希

GetY 每轮都会运行连接器；不能因为“内容没变”就重复 upsert。state 里保存：

```ts
docs: Record<docId, contentHash>;
```

只有哈希变化才 `upsert`；上一轮有、这一轮没有的 docId 才 `del`。

### 5.3 大文件缓存

WorkBuddy 的 trace 解析成本高（几百个 JSON）。用一个本地缓存文件保存解析结果：

```text
%LOCALAPPDATA%\gety-workbuddy-connector\cache-v1.json
```

按 `path + mtime + size` 复用；解析器逻辑变化时提升 `cache-v1` 版本号。

### 5.4 读失败不要删

数据库/目录读失败时：

```ts
yield { updates: [], state: this.lastState ?? initialState };
```

不要因为“读到 0 条”就删光文档 —— 这是连接器最容易造成数据事故的地方。

---

## 6. 接入 GetY

### 6.1 manifest

最小可用：

```json
{
  "id": "dsh_sessions",
  "name": "DeepSeek Harness",
  "version": "1.0.0",
  "min_gety_app_version": "0.5.1",
  "capabilities": ["data-source"],
  "entry": "dist/main.js",
  "icon": "assets/icon.svg",
  "schedule": { "strategy": "interval", "interval_seconds": 600 },
  "config": { "fields": [] },
  "doc_link": { "kind": "url", "field": "url" }
}
```

### 6.2 安装与验证

GetY 有本地 CLI，可直接自动化：

```powershell
& "$env:LOCALAPPDATA\Gety\Gety.exe" connector install <connector-dir> --json
& "$env:LOCALAPPDATA\Gety\Gety.exe" connector list --json --kind all
& "$env:LOCALAPPDATA\Gety\Gety.exe" connector enable <id> --json
& "$env:LOCALAPPDATA\Gety\Gety.exe" connector poll <id> --json
& "$env:LOCALAPPDATA\Gety\Gety.exe" connector show <id> --json
```

验证三件事：

1. `searchable_doc_count` 符合预期；
2. `GetDoc` 能读到正文和 metadata；
3. 取消/恢复范围（如果有）后，文档数正确变化。

### 6.3 构建

GetY 自带 Deno，直接使用：

```powershell
& "$env:LOCALAPPDATA\Gety\deno.exe" task verify
```

`deno bundle --external @gety-ai/connector-sdk` 会把本地代码和依赖打进 `dist/main.js`，SDK 由 GetY 运行时注入。

---

## 7. 一键插件（如果客户端支持）

DSH 支持 Cordis 插件，所以能做到“在插件页一键连接”。模式：

- **Host 插件**：注册 4 个同源路由（state / connect / workspaces / sync），调用本机 `gety connector ...` CLI。
- **Client 插件**：注册到 `plugins.bundle.config`，渲染状态、连接按钮、工作区多选（默认全选）。
- **工作区选择**：写到客户端自己的配置文件（DSH 是 `~/.dsh/gety-connector.json`），连接器轮询时读取。
- **安装**：插件把内置连接器复制到稳定目录，再调用 GetY CLI；用 manifest+dist 的 SHA-256 判断是否需要更新。

WorkBuddy 没有这种插件入口，就不要硬做 UI：一个 `install-workbuddy.ps1` + GetY 设置页已经足够。

---

## 8. 隐私红线

- 不索引工具输出、命令输出、reasoning。
- 不索引系统提示、注入上下文、技能目录、身份/记忆文件。
- 不读取 API key、cookie、token；SQLite 只读。
- 不发起网络请求；所有数据来自本机会话文件。
- 在 README 和文档里写清楚“哪些内容没被索引”，尤其是云端正文。

---

## 9. 验证清单

- [ ] `deno task verify`：fmt、lint、check、test、build 全绿。
- [ ] 真实数据首轮：文档数 = 会话数 + 可归类的 trace 数（符合预期）。
- [ ] `GetDoc` 抽查 2–3 篇：标题、正文、metadata、时间戳正确。
- [ ] 增量轮：无变化时不产生 upsert。
- [ ] 删除/取消范围：对应文档被删除。
- [ ] 数据库/目录读失败：不删除文档。
- [ ] 客户端重启、GetY 重启后仍能工作。
- [ ] 不包含任何密钥、用户目录以外的路径或私有 URL。

---

## 10. 常见坑

| 坑 | 处理 |
| --- | --- |
| zstd 多帧只解出第一帧 | 用 fzstd 的 `Decompress`，不要用流式单帧解压 |
| 会话日志被系统注入内容污染 | 按 `source.kind` / `<user_query>` 过滤 |
| 自动化/定时任务产生大量噪音 | 过滤 `automation_system_reminder`、固定提示词 |
| 内部 JSON 被当成回答 | 过滤 `isNewTopic` / `title` 控制 payload |
| 云端正文没有本地副本 | 只索引元数据，并在文档里明确说明 |
| 重复 trace 导致同一段话出现多次 | 按 `role + text` 去重 |
| 每轮重新解析几百 MB | 用 mtime/size + 本地解析缓存 |
| 数据库读失败导致文档被删光 | 读失败时返回上一轮 state，不产生 del |
| 工作区目录名编码不一致 | 优先用 workspace id / sessionId 匹配，路径匹配做兜底 |
| 插件移动后失效 | 在 README 里说明 link 安装的约束，或安装到稳定目录 |

---

## 11. 复用模板

```text
<client>-connector/
  manifest.json
  deno.json
  src/
    index.ts        # poll、状态、upsert/del
    <client>_log.ts # 解析 + markdown
    <client>_home.ts# 路径、DB、文件枚举
    gen/manifest.d.ts
  dev/
    sdk_shim.ts
    run.ts
  dist/main.js
  assets/icon.svg
```

先做“只读侦察 → 最小 manifest → 单会话解析 → 本地 runner → 安装到 GetY → 真实搜索验证”，再考虑工作区选择、插件 UI、缓存优化。
