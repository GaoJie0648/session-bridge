# session-bridge

讓 Codex CLI 與 Claude Code 雙向讀取對話、互傳訊息、啟動背景協作任務、在用量快到上限時提醒並交接的本機 MCP server。bridge 不直接修改 session 檔；背景 agent 透過各自的官方介面建立與恢復 session。訊息與任務另存於 `~/.session-bridge/`。

## 工具

| 工具 | 用途 |
|------|------|
| `list_sessions` | 列出兩邊的 session（新到舊）。預設只列目前專案，`all=true` 涵蓋所有專案 |
| `read_session` | 讀取對話文字；工具呼叫只顯示一行摘要。預設回傳最後 30 則，可用 `offset` / `limit` 分頁，`roles` 只看指定角色（例如只看使用者說的話） |
| `get_entry` | 以 `[index]` 取得單一則的完整內容（工具呼叫含完整輸入與輸出） |
| `search_sessions` | 在對話文字中搜尋關鍵字（不分大小寫，不含工具輸出） |
| `send_message` | 傳訊息給另一個 session（交接、提問、回報），對方會自動收到並處理 |
| `check_inbox` | 取出某個 Claude Code session 的未讀訊息；平常會自動送達，漏接時才需要 |
| `start_task` | 啟動 Codex 或 Claude 背景任務，不需要對方已有開著的 session |
| `get_task` / `list_tasks` | 查看任務、進度、結果、待審批與額度狀態 |
| `resume_task` | 恢復已停止的任務，或指定另一個 provider 接手 |
| `cancel_task` | 取消背景任務並撤銷該任務的 automode |

`source` 為 `codex` 或 `claude`；`cwd` 請傳入專案目錄的絕對路徑，省略時使用 server 啟動時的工作目錄。

## 使用方式

在任一邊直接用自然語言要求即可，例如：

- 「用 session-bridge 看一下 Codex 在這個專案最後做了什麼，然後接著做」
- 「搜尋 Claude Code 的 session 裡有沒有討論過廣告跳過」

## 背景協作：Codex ↔ Claude

在 CC 說「用 session-bridge 啟動 Codex 幫我檢查這次修改，完成後回報」，或在 Codex 說「啟動 Claude 幫我實作這個功能」即可。兩邊使用相同工具與控制入口。

`start_task` 範例：

```json
{
  "provider": "codex",
  "cwd": "C:/work/my-project",
  "prompt": "檢查 src/auth.js 的修改，補上必要修正並執行測試；不要 commit 或 push。",
  "from_source": "claude",
  "from_id": "目前 Claude session 的 UUID",
  "auto_retry": true
}
```

反向改成 `provider="claude"`、`from_source="codex"`。回傳的 `id` 是 **task id**，與原生 session id 不同。`from_source` / `from_id` 一起提供時，完成、額度暫停或待審批都會通知原 session；未提供仍能透過 `get_task` 或控制指令查看。回報失敗保留在 `notificationError`，不會丟掉結果。

每個任務由獨立背景行程管理，關閉發起端 MCP 不會停止任務。Codex 使用 [app-server](https://learn.chatgpt.com/docs/app-server)；Claude 使用官方 [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 與 `canUseTool` 回呼，預設使用 SDK 隨附的 CLI。沿用本機登入與原生設定；不切換 API key 或付費方式。可用 `SESSION_BRIDGE_CODEX` / `SESSION_BRIDGE_CLAUDE` 指定執行檔（Windows 請用 `.exe` 或 `.js`，不要 `.cmd`）。

背景任務沒有視窗；設定了 Claude Code 的 statusline（見[用量提醒](#用量提醒)）時，底部會顯示還沒結束的任務，例如 `codex 執行中 1 · claude 待審批 1`（狀態依序為執行中、待審批、等額度、需處理），任務結束後就不再顯示。

任務狀態：`queued` → `running`，執行中可能進入 `waiting_approval` 或 `waiting_quota`，最後為 `completed` / `failed` / `interrupted` / `cancelled`。`cancelling` 表示停止尚未完成；看到 `cancelled` 後再接手。無法確認原 agent 已停止時為 `recovery_required`，請檢查 `agentPid` 與行程，停止原行程後才能恢復。`get_task` 的 `workerAlive` 可辨認背景行程是否仍存在。非預期中斷後，使用 `resume_task` 恢復；舊審批不會沿用。

兩個 agent 寫入同一個工作目錄時仍可能衝突；交辦時分開檔案範圍，或指定已建立的不同 worktree。bridge 只保證同一 task 不會同時啟動兩個 worker。

### 本機同意入口與 automode

不需要 AI 還有額度，也不需要保持對話視窗開著。在這個 repo 的終端直接執行：

```powershell
# 查看狀態與 pending approvals 的完整操作內容、審批 ID
node src/control.js list
node src/control.js show <task-id>
node src/control.js watch <task-id>

# 同意／拒絕一次
node src/control.js approve <task-id> <approval-id>
node src/control.js deny <task-id> <approval-id>

# 對此任務目前的 provider，後續審批自動同意 60 分鐘
node src/control.js auto <task-id> on --minutes 60

# 只自動同意檔案編輯，其他審批仍手動處理
node src/control.js auto <task-id> on --minutes 30 --kinds file

# 隨時關閉，或取消整個任務
node src/control.js auto <task-id> off
node src/control.js cancel <task-id>
```

安裝了套件的 bin 時，可將 `node src/control.js` 換成 `session-bridge-control`；也可從任意目錄使用 `node "C:/path/to/session-bridge/src/control.js" ...`。MCP 工具回傳的 `control` 欄位會列出指令。

automode 預設涵蓋 `command,file,tool,permissions`，期限可設 1–480 分鐘，會同意符合種類的目前待審批與後續請求。**它是你給這個任務的限時預先授權，不是風險分類器或工作目錄隔離器**；命令、工具或權限請求可能涵蓋目錄外資源。每次只回覆單次／當回合的同意，不寫入永久允許規則。切換 provider、完成或取消任務後失效；額度等待期間仍按原到期時間計算。

automode 不回答問題、不填表、不修改全域 CLI 設定、不繞過服務商的禁止規則或組織明確要求的人工審批。原生已允許的工具照常執行；只有送到 bridge 的審批會顯示在這裡。此入口只管理 **bridge 啟動的背景任務**，不攔截其他已開著的互動 session 的提示。

審批 ID 綁定當次請求；完成、取消、原生撤回或一小時逾時後失效。問題／MCP 表單需用 `answer` 提交 JSON 檔：

```powershell
node src/control.js answer <task-id> <approval-id> --file answer.json
```

依 `show` 裡的 `method` 與 `details` 填入：

| 請求 | answer.json 範例 |
|------|-----------------|
| Codex `item/tool/requestUserInput` | `{"answers":{"question-id":{"answers":["選項或文字"]}}}` |
| Claude `AskUserQuestion` | `{"answers":{"問題原文":"選項或文字"}}` |
| Claude `ExitPlanMode` | `{}` 表示接受該次計畫 |
| MCP elicitation | `{"action":"accept","content":{"欄位":"值"}}`，欄位依請求 schema |

審批與 automode 刻意沒有暴露為 MCP 工具；請由使用者在終端操作。這是同一個本機帳號下的協作工具，控制檔案不是針對擁有該帳號任意 shell／檔案權限的程式所設的安全隔離。

### 額度用完與雙向接手

- 明確的額度限制會進入 `waiting_quota`；已知重置時間時，預設在重置後 5 秒嘗試恢復。短暫限流採 30／60／120 秒退避，每次手動恢復後最多自動重試三次。
- 沒有可確認的重置時間時保留任務，不猜測恢復時間。`auto_retry=false` 關閉自動重試。
- `resume_task` 或下列指令可選原 provider 繼續，或改由另一邊接手：

```powershell
node src/control.js resume <task-id>
node src/control.js resume <task-id> --provider claude
node src/control.js resume <task-id> --provider codex --prompt "先核對目前變更，再繼續未完成部分"
```

若交辦時已同意自動轉交，`start_task` 可加 `fallback_provider`，指定與 `provider` 不同的另一邊。遇額度限制時最多自動切換一次，避免互踢；兩邊都受限就保存進度並暫停。各 provider 的原生 session id 會保留。轉交會附上原任務、最近文字進度與持續落盤的操作紀錄；接手者仍須核對實際檔案與外部操作結果，不能保證跨 provider 的外部操作 exactly-once。

任務檔位於 `~/.session-bridge/tasks/<task-id>/`（可由 `SESSION_BRIDGE_HOME` 覆寫）：`task.json` 保存狀態，`events.jsonl` 保存操作與進度，`worker.log` 保存背景行程錯誤，`commands/` 與 `receipts/` 保存控制指令及處理結果。控制端逾時只代表尚未確認，不代表成功；可用 `show` 與 receipt 核對。任務與操作紀錄目前不會自動清除。

## 訊息傳遞

在任一邊說「把這件事交給 Codex 的 session `<id>`」或「做完後回報給 Claude」即可，agent 會呼叫 `send_message`。

| 方向 | 送達方式 |
|------|----------|
| → Codex CLI | `codex queue` 直接送進該 session：閒置時立刻喚醒，忙碌時排在目前回合之後。session 沒有開著時會留在佇列，下次開啟才處理 |
| → Claude Code | 寫入信箱；Claude 的 `Stop` hook 在回合結束後留在背景等信，信到就喚醒它 |
| 完成回報 | 收到訊息的一方回合結束時，最後一則回覆會自動轉寄給寄件者；已用 `send_message` 主動回覆就不再轉寄 |

`send_message` 的 `expects_reply` 決定要不要完成回報：新的交辦預設要；回覆對方來信預設不要，避免雙方輪流為了回報多跑一回合。純通知設 `false`，回覆裡有問題要對方回答時設 `true`。

減少往來成本的做法：

- 送出成功就代表送達，不需要請對方回覆確認收到。
- 分工、規則、進度這類雙方都要遵守的內容寫進一個共用檔案，訊息裡只給路徑與這次的變動。
- 要核對使用者的原話時用 `read_session` 的 `roles=["user"]`，不必把對方整段對話連同工具紀錄讀進來。

限制：

- 每個開著的 Claude Code session 在回合結束後會留一個背景行程等信，最長 6 小時，session 關閉時自動結束；超過 6 小時沒有新回合的 session 要到下一次回合結束才會收到。
- 自動轉寄的回報不會再觸發回報；同一對 session 一小時內最多互傳 30 則、單一 session 一小時內最多收 60 則，超過會被拒絕。
- 訊息等同另一個 agent 下的指令，對方會直接照做；各自的權限確認設定仍然有效。建議不要把 `send_message` 加進免確認的允許清單。
- 寄件者位址由呼叫的 agent 自填，只驗證該 session 存在，無法證明真的是它寄的。
- 已處理的訊息保留七天。

### 設定 hook

Claude Code：在 `~/.claude/settings.json` 的 `hooks` 加入（路徑換成實際位置）：

```json
{
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node", "args": ["C:/path/to/session-bridge/src/hook.js", "claude"], "timeout": 15 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node", "args": ["C:/path/to/session-bridge/src/hook.js", "claude"], "timeout": 15 }] }],
  "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node", "args": ["C:/path/to/session-bridge/src/hook.js", "claude"], "timeout": 15 }] }],
  "Stop": [{ "hooks": [{ "type": "command", "command": "node", "args": ["C:/path/to/session-bridge/src/hook.js", "claude"], "asyncRewake": true, "timeout": 21700 }] }]
}
```

用量提醒另需在同一個檔案的最上層加入 statusline（見[用量提醒](#用量提醒)）：

```json
{
  "statusLine": { "type": "command", "command": "node C:/path/to/session-bridge/src/statusline.js" }
}
```

Codex CLI：建立 `~/.codex/hooks.json`，再到 Codex 內執行 `/hooks` 信任這四個 hook（未信任的 hook 不會執行）：

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/session-bridge/src/hook.js codex", "timeout": 15 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/session-bridge/src/hook.js codex", "timeout": 15 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/session-bridge/src/hook.js codex", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/session-bridge/src/hook.js codex", "timeout": 60 }] }]
  }
}
```

沒有設定 hook 時 `send_message` 仍可把訊息送進 Codex，只是不會有自動回報，Claude 端也要自己呼叫 `check_inbox`。

## 用量提醒

互動 session 執行中，每次工具呼叫後與使用者送出訊息時都會檢查 5 小時與週用量，兩個時窗套用相同規則：

| 用量 | agent 收到的提醒 | 桌面通知 |
|------|------------------|----------|
| ≥ 80% | 規劃收尾：完成手上的步驟，不開始大型新步驟，讓進度保持可交接 | 有 |
| ≥ 90% | 立刻停在安全點，用 `send_message` 把工作交接給同專案最近有動靜的另一邊 session，然後停止並告知使用者 | 有 |

- 同一 session、同一時窗、同一級別只提醒一次；時窗重置後重新計算。直接跳到 90% 時不會再補發 80% 的提醒。
- 90% 時若同專案找不到另一邊的 session，或另一邊的用量也已達 90%，就不交接，改把交接內容寫在回覆裡，由使用者決定。
- 桌面通知只在 Windows 送出，同一帳號同一級別只跳一次（多個 session 開著也一樣）。設 `SESSION_BRIDGE_NOTIFY=0` 可關閉。
- 用量是帳號層級的。快照存在 `~/.session-bridge/usage/`，另一邊判斷能否接手時也會參考。

資料來源：

| 端 | 用量來源 | 需要的設定 |
|----|----------|------------|
| Codex CLI | rollout 檔每回合寫入的 `rate_limits` | `hooks.json` 的 `PostToolUse`、`UserPromptSubmit` |
| Claude Code | 只有 statusline 的輸入有 `rate_limits`，hook 拿不到，所以由 `src/statusline.js` 存成快照再給 hook 讀；底部會顯示 `5h 42% · 7d 18%`，有背景任務時接著顯示 `codex 執行中 1` | `statusLine` 與 `PostToolUse`、`UserPromptSubmit` hook |

限制：

- Claude Code 的 `rate_limits` 只提供給 Pro／Max 訂閱，且要在 session 第一次 API 回應之後才有。快照超過 10 分鐘沒更新時不採用。
- 已經有自訂 statusline 時，要讓既有 script 也把輸入轉給 `src/statusline.js`，或把兩者的輸出合併。
- 交接靠 agent 依提醒呼叫 `send_message`；如果額度在交接前就已用完，交接不會發生。

## 資料來源

| 工具 | 位置 | 覆寫用環境變數 |
|------|------|----------------|
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl`、`~/.codex/session_index.jsonl` | `CODEX_HOME` |
| Claude Code | `~/.claude/projects/<專案>/<id>.jsonl` | `CLAUDE_CONFIG_DIR` |

兩者皆為未公開的內部格式，CLI 改版後若讀不到內容，需調整 `src/codex.js` 或 `src/claude.js`。Codex 的 subagent session 與推理內容（已加密）不會被讀取。

## 安裝

需要 Node.js 22 以上。

開發這個 repo 時，先 `npm ci`，再將兩邊 MCP 設定的 command 改成 `node`、args 改成此 repo 的 `src/server.js` 絕對路徑，並重啟／重新連線 MCP。若設定仍使用下方 GitHub 安裝指令，會執行遠端版本，尚未發布的本機修改不會生效。

```powershell
claude mcp add --scope user session-bridge -- cmd /c npx -y github:GaoJie0648/session-bridge
codex mcp add session-bridge -- cmd /c npx -y github:GaoJie0648/session-bridge
```

repo 為私有，該機器的 git 需先能存取（`gh auth login`）。macOS / Linux 去掉 `cmd /c`。

以上指令以 PowerShell 為準。在 Git Bash 執行時 `/c` 會被自動轉成 `C:/`，導致 server 連不上，需在指令前加上 `MSYS_NO_PATHCONV=1`：

```bash
MSYS_NO_PATHCONV=1 claude mcp add --scope user session-bridge -- cmd /c npx -y github:GaoJie0648/session-bridge
MSYS_NO_PATHCONV=1 codex mcp add session-bridge -- cmd /c npx -y github:GaoJie0648/session-bridge
```

安裝後可用 `claude mcp get session-bridge` 確認 Args 為 `/c npx ...` 且狀態為 Connected。

只會讀取執行所在機器的 session，不會跨機器同步。

移除：`claude mcp remove session-bridge -s user`、`codex mcp remove session-bridge`。

## 測試

```powershell
npm test
```

測試包括雙向背景啟動、審批、automode、額度暫停／接手，以及從另一個終端控制獨立 worker；預設使用模擬 provider，不消耗模型額度。`node scripts/smoke-agents.js` 是另外的真實介面驗證，使用本機登入，各向 Codex／Claude 發出一次禁止工具操作的極短請求，會消耗少量額度。
