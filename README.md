# dsh-session-switch

DeepSeek Harness 的**会话切换**插件。

它只负责"会话"那一摊：接别人的请求 → 建新会话 → 把交接包作为新会话的**第一条消息**发进去
→ 把待接写给客户端 → 界面切过去 → 归档原会话。

**它不碰记忆档案。** 那份活是 `dsh-auto-handoff` 的（写日记/状态/生长记录、拼交接包）。
两个插件只靠**一个 HTTP 调用**和一个**约定文件**握手，**各自单独装都能用**。

---

## 它和谁一起用

```
dsh-auto-handoff（管档案）              dsh-session-switch（管会话）
  到 65% → 写日记/状态/记录
        → 拼交接包
        → POST /api/session/switch  ──────────►  建新会话
                                                  followup(交接包)  ← 新会话第一条消息
                                                  写 pending.json
        ◄──── { ok:true, pending:{newSessionId} }
  叫不动？→ 自己降级：把待接写到
            ~/.dsh/session-switch/pending.json
                                    （客户端）读 pending → 切界面 → ack
```

- 两半**都不需要对方在场**：auto-handoff 叫不动本插件时会自己降级，本插件装不装它都能跑。
- 只装本插件、没装 auto-handoff：路由都在，只是没人来调。

---

## 两半的分工（重要）

| | 做什么 | 不做什么 |
|---|---|---|
| **Host**（`index.js`） | 注册 4 条路由、建会话、发交接包、写/读 `pending.json`、ack 去重、归档 | 不碰界面，不碰记忆档案 |
| **Client**（`client.js`） | **什么都不做**（空壳） | 不注册 slot、不写 DOM、不轮询、不抛错 |

**Client 为什么是空壳？** 踩过坑：

1. 一开始它自己也开新会话 → 和 `dsh-auto-handoff` 的客户端**两边各切一次**：
   界面跳一半又跳一下，两个 pending 互相覆盖，ack 谁先谁后说不清。
2. 于是定成 **"界面动作由 auto-handoff 的客户端做，本插件的客户端保持空壳"**：
   切界面这件事谁做都行，但**只由一个人做**。
3. 附带好处：客户端以前抛过一次错、把设置页搞白了；空壳没有可抛的东西，
   这类事故从结构上就不可能再发生。

所以：**建会话 / 发消息 / 写 pending 全在 Host 半边**；客户端（哪个都行）
只负责"读到 pending → 切过去 → ack"。

---

## HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/session/switch` | 收下切换请求 |
| GET | `/api/session/pending` | 客户端轮询待接 |
| POST | `/api/session/ack` | 界面切完回报 |
| GET | `/api/session/health` | 自检 |

### `POST /api/session/switch`

请求（`dsh-auto-handoff` 发的就是这个形状）：

```json
{
  "sourceSession": "session-xxxx",
  "seq": 48,
  "handoff": "……约 1200 字的交接包……",
  "cwd": "D:\\dsh",
  "provider": "deepseek-official",
  "model": "deepseek-flash"
}
```

成功：

```json
{ "ok": true, "pending": { "newSessionId": "session-xxxx" } }
```

失败（**明确错误 JSON，不会挂住**）：

```json
{ "ok": false, "error": "建会话失败：……" }
```

- `handoff` 为空 → `400`。
- 建会话失败 → `500`，而且**不写 pending**（写了等于让客户端切到一个不存在的会话）。
  调用方会自己降级成"把待接写进约定位置"，这是设计好的分工。
- 也可选传 `agentPreset` / `permissionPreset`；不传就用部署的默认值。
- 没传 `cwd` 时用进程当前目录。

### `GET /api/session/pending`

**永远 200**，没有待接时返回空壳，**绝不 404**：

```json
{ "ok": true, "pending": null, "empty": true, "stale": false }
```

> **为什么 404 有害**：客户端是**每 10 秒一次**的定时轮询。返回 404 会让浏览器
> Console 每 10 秒多一条红色报错，真正的错误反而被淹掉。原版踩过这个坑。

有待接时 `pending` 里就是 `pending.json` 的内容。

### `POST /api/session/ack`

```json
{ "at": "2026-09-25T11:40:00.000Z" }
```

- 按 **`at`** 去重：同一条 ack 第二次来会得到 `{ ok:true, acked:true, duplicate:true }`，
  不再执行一遍。
- ack 之后 `pending` 读出来是**空**（客户端不会重切），但 `at` 留在盘上（去重凭据）。
- 顺手归档**源**会话；归档失败只记日志，不影响 ack —— ack 的语义是"界面已经切过去了"。

### `GET /api/session/health`

```json
{ "ok": true, "plugin": "dsh-session-switch", "half": "host", "stateDir": "C:\\Users\\…\\.dsh\\session-switch" }
```

---

## 状态目录

默认 `~/.dsh/session-switch/`，可用环境变量覆盖：

```powershell
$env:DSH_SESSION_SWITCH_DIR = "D:\somewhere\session-switch"
```

（跟 `dsh-auto-handoff` 的降级路径用的是**同一个**环境变量，所以两边会写到同一个地方。）

目录里两个文件：

| 文件 | 内容 |
|---|---|
| `pending.json` | 待接。字段：`at / mode / seq / sourceSession / newSessionId / handoff / handoffChars / note`；ack 之后多出 `handled: true` 和 `handledAt`（去重凭据，`pending` 从此读出来是空） |
| `session-switch.log` | 文件日志 |

**`session-switch.log` 记得什么**（原版特意加的：跨插件调用到底通没通，光看 Console 看不出来）：
`apply` 进入 / 每条路由注册 / 收到切换请求 / 建会话成功 / 建会话失败 / 没建会话的降级 /
待接被丢弃（坏 JSON、空文件）/ 超过 2 小时被跳过 / ack 去重。

---

## 装

```powershell
# 先在隔离的 DSH_HOME 里试（别拿天天在用的 profile 当试验田）
$env:DSH_HOME = "C:\some\isolated\dsh-home"
dsh plugin --profile web add "C:\path\to\dsh-session-switch"
```

（`add` 接受**本地路径**；也可以改成包名从 registry 装。装完先 `dsh plugin --profile web ls` 看它在不在。）

包内的 `cordis.patch.yml` 会自动被读，**不用手工改任何文件**。
手工插一行怎么写见 `cordis.patch.example.yml`。

---

## 自检

```powershell
$env:DSH_SESSION_SWITCH_DIR = "$env:TEMP\dsh-session-switch-selftest"   # 必须指向临时目录
node index.js --selftest
```

覆盖：①文件不存在时读待接是"空"而不是报错 ②写一条能读出来 ③ack 后不再重复返回
③b 重复 ack 按 `at` 去重 ③c ack 后 `/pending` 为空 ④坏 JSON 不崩且记日志
⑤超过 2 小时的旧待接被跳过并记日志 ⑥`/pending` 无待接时 200+空（不是 404）
⑦建会话失败返回明确错误 JSON 且不写 pending ⑦b 失败时不写 pending
⑧缺少建会话服务时**点名说缺谁** ⑨交接包发不进去时回滚半成品会话（`dispose` 到位）
⑩方法不对给 405。

**自检强制要求 `DSH_SESSION_SWITCH_DIR`**，并且会拒绝在真实 `~/.dsh` 下跑 ——
本插件不会往你的活环境里写测试数据。自检在**模块层**执行（`if (process.argv.includes('--selftest'))`），
不在 `apply()` 里：独立跑 `node index.js --selftest` 时 cordis 根本不会调 `apply()`，
放进去会"一声不吭地退出"，看起来通过了、实际什么都没测（原版第一版就栽在这儿）。

> **一个已知的"看目录"效应**：如果你在**还没装**的情况下、直接在插件源码目录里跑自检，
> 第 ⑨ 项会报 `Cannot find package '@deepseek-ai/dsh-llm'` —— 那不是缺陷，是
> "包还没被装进 profile 的 node_modules，所以 `@deepseek-ai/dsh-llm` 解析不到"。
> 也正因为它，`createUserMessage` 走的是**懒加载**而不是静态 `import`：静态 import
> 会让这件事在模块加载阶段就炸掉，自检连一行都跑不出来。装进 profile 之后这一项就是真通过。

---

## 排查

| 现象 | 先看什么 |
|---|---|
| 交接后界面没切 | `session-switch.log` 有没有"收到切换请求"；有则是客户端那半边的事 |
| 日志里只有"apply 进入" | 路由没注册成功，看有没有 `duplicate exact route` 之类的错误 |
| 客户端 Console 每 10 秒一条红 | 不该发生；`/pending` 被别的东西抢了路径 |
| 切过去是空会话 | 交接包没发进去：看日志里的 `handoff=… 字` 是不是 0 |

---

## 版本接口备注

- `ctx.agents.create`、`ctx.workspaceRegistry.create` / `attachSession` / `archiveSession`、
  `ctx.agentPresets.resolve` / `mount`、`ctx.permissionPresets.defaultPreset` / `resolve` / `set`、
  `ctx.sessionTitle.rename`、`ctx.webServer.register` —— 当前 `@deepseek-ai/dsh` 0.1.7-rc.1
  都**还在**，按官方 `dsh-webhook` 的 `createWebhookSession` 用法实现。
- `ctx.agents.create` 的旧签名（`config` 里那种）当前版本已无，走的是 `create({ sessionId, meta, agentOptions, setup })`。
- 发第一条消息用 **`followup`**（不是一个叫 `inject` 的接口）：`inject` 是往"当前这一步"里插，
  而这是全新对话的开场白，必须是这个新会话的第一条用户消息。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
