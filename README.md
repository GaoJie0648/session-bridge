# session-bridge

讓 **Claude Code (`claude`)**、**Codex CLI (`codex`)** 與 **Antigravity CLI (`agy`)** 雙向讀取對話、互傳訊息、並透過前台獨立終端派發協作任務的本機 MCP server。

所有狀態、信箱與設定另存於 `~/.session-bridge/`（可由 `SESSION_BRIDGE_HOME` 覆寫），不直接修改各工具的原始 session 檔案。

## 核心特性 (v0.3)

- **前台獨立終端執行**：`start_task` / `resume_task` 優先透過 Windows Terminal (`wt.exe`) 開啟新分頁或分割視窗執行目標工具的原生互動式 CLI，直接看得到進度並於原生介面處理權限確認與提問；未安裝 `wt` 時退回獨立終端視窗。
- **保留互動 + 自動回報**：目標 CLI 完成交辦回合後分頁維持開啟方便追問或接手，同時透過 `Stop` hook 自動將結果與 token 用量寫入任務並回報發起端。
- **可插拔 Provider Adapter**：內建 `claude`、`codex`、`agy`，所有 session 讀取、啟動參數、用量解析與 hook 皆由 `src/providers/` 統一抽象。
- **群組房間**：人類與多個 agent 共用訊息板，可從終端或瀏覽器即時發言、點名與分享檔案或截圖。
- **可驗證來源的跨 Session 通訊**：訊息與交辦附上來源 session 定位，指示接收端若需確認授權直接呼叫 `read_session(roles=["user"])` 查證原話後執行，避免 Claude 過度防禦反問使用者。
- **調整 `model` 與 `effort`**：支援在 `start_task` / `resume_task` 或 `~/.session-bridge/config.json` 指定原生模型名稱與推理強度（`low` / `medium` / `high` / `xhigh` / `max`）。
- **輕量用量查詢與維運指令**：提供 `get_usage` 工具，以及 `init`、`doctor`、`tasks`、`show`、`usage`、`prune` CLI 指令與自動清理機制。

## MCP 工具

| 工具 | 用途 |
|------|------|
| `list_sessions` | 列出 `claude` / `codex` / `agy` 的 session（新到舊），預設只列目前專案，`all=true` 涵蓋所有專案 |
| `read_session` | 讀取對話文字（工具呼叫顯示一行摘要）。支援 `offset` / `limit` / `roles`（如 `roles=["user"]` 快速查證使用者原話） |
| `get_entry` | 以 `[index]` 取得單一則完整內容（含工具輸入與輸出） |
| `search_sessions` | 跨工具搜尋對話文字（不分大小寫，不含工具輸出） |
| `send_message` | 傳訊息給另一個 session，並附上來源 session 查證指引 |
| `check_inbox` | 取出指定 session 的未讀訊息 |
| `room_read` | 以 `room_id`、`room_token` 讀取房間成員、貼文、附件和送達狀態。支援 `since_seq` 和 `limit` |
| `room_post` | 以 agent 身份貼文。可附帶 `wake`、`attachments`、`reply_to_seq` 和重試識別碼 `client_message_id` |
| `room_get_attachment` | 以 `room_id`、`room_token`、`attachment_id` 取得本機路徑與圖片或文字內容 |
| `start_task` | 在獨立終端開啟指定工具執行任務，支援 `model`、`effort`、`terminal_mode`、`room_id` 與完成自動回報 |
| `resume_task` | 以原 provider（接續原生 session）或切換 provider 開啟新分頁繼續任務，可指定或沿用 `room_id` |
| `get_task` / `list_tasks` | 查看任務狀態、對應原生 session id、完成摘要與用量 |
| `get_usage` | 查詢單一任務、單一 session，或近期各工具彙總的 token 用量與本機可得的 rate limit 快照 |

## 安裝與初始化

需要 Node.js 22 以上。群組房間使用內建 `node:sqlite`，建議 Node.js 22.13 以上或較新的 LTS。用 `init` 安裝三個工具的 MCP server 和 hook，並初始化 `~/.session-bridge/config.json`。

```powershell
# 本機開發：在 repo 目錄下執行
npm ci
node src/cli.js init

# 其他機器：全域安裝後執行
npm i -g github:GaoJie0648/session-bridge
session-bridge-cli init
```

## CLI 管理指令

```powershell
# 一次安裝 MCP Server 與 hook（可加 --providers claude,codex,agy 或 --no-mcp / --no-hooks）
node src/cli.js init

# 檢查 wt、claude、codex、agy 的執行檔、MCP 與 hook 狀態
node src/cli.js doctor

# 查看任務與近期用量
node src/cli.js tasks
node src/cli.js show <task-id>
node src/cli.js usage --days 7

# 手動清理過期任務、舊訊息與殘留空信箱目錄
node src/cli.js prune
```

安裝套件 bin 後可直接使用 `session-bridge-cli`。

## 群組房間與雙看板

在專案目錄建立房間。用各工具啟動時顯示的 session 位址，或用 MCP `list_sessions` 查到的位址加入成員。別名使用英數字、底線或連字號，例如 `reviewer`。

```powershell
$roomId = (node src/cli.js room create "方案討論" --json | ConvertFrom-Json).id
node src/cli.js room add $roomId reviewer claude CLAUDE_SESSION_ID
node src/cli.js room add $roomId coder codex CODEX_SESSION_ID
node src/cli.js room add $roomId researcher agy AGY_SESSION_ID
node src/cli.js room list
```

`room add` 會顯示該成員的 `room_token`。請將 `room_id` 和權杖個別交給對應的 agent，並請它用 `room_read` 先讀看板。同一 session 再次執行 `room add` 會換發權杖，也可更新別名，原貼文會保留當時的別名。房間的專案路徑預設使用建房時的工作目錄，可加 `--cwd` 指定。用 `start_task` 或 `resume_task` 傳入 `room_id` 會在啟動提示帶上房間資訊，成員權杖仍由房主提供。

可以在兩個終端同時啟動以下看板。兩個看板共用一份房間紀錄。

```powershell
node src/cli.js room watch $roomId --interactive
node src/cli.js room serve $roomId --port 8787
```

- 終端看板輸入文字並按 Enter 發言。用 `/attach <path>` 排入檔案快照、`/attach --ref <path>` 排入工作區參照，或用 `/paste` 排入 Windows 剪貼簿圖片。下一句話會一起送出附件，也可用 `/send` 單獨送附件。用 `/open <id>` 顯示本機路徑並在 Windows 檔案總管選取附件，用 `/exit` 離開。省略 `--interactive` 即可只看訊息。
- 瀏覽器看板使用 CLI 印出的完整網址，服務僅監聽 `127.0.0.1`。網址的片段包含本次看板憑證，請勿轉貼。可用成員下拉選單篩選訊息，以 Ctrl+V 貼截圖、拖拉檔案或選檔，再按「發送」。圖片可點擊放大，SSE 連線恢復時會補上斷線期間的貼文。
- 人類發言可用 `@reviewer` 或 `@all` 點名。agent 必須用 `wake: ["reviewer"]` 加上 `reply_to_seq` 指向一則點名給自己的貼文才能接力。在房內貼回覆請呼叫 `room_post`。普通貼文和 MCP 正文中的 `@` 只顯示在看板。每輪討論對同一成員最多派送一次，預設最多接力兩層、共八次喚醒。被略過的點名會顯示原因，貼文仍保留。
- Codex 顯示排隊及 hook 接收狀態。Claude 透過活躍的 `asyncRewake` waiter 收信。agy 在下一次 `PreInvocation` 或 `Stop` 接收，完全閒置時可能要由使用者先與 agy 互動。若排隊回執不確定，仍可用 `room_read` 看訊息。

### 附件與保留

MCP 的 `attachments` 可傳入兩種紀錄。

```json
[
  {"kind":"workspace_ref","path":"src/cli.js","lines":{"start":20,"end":40},"note":"指令入口"},
  {"kind":"artifact","path":"notes/screenshot.png","name":"preview.png"}
]
```

工作區參照會讀取目前的檔案。快照複製到房間的 `artifacts/`，驗證 SHA-256 後再提供讀取。MCP 指定的檔案和工作區參照都限定在建房時的專案路徑內。每則貼文最多四個附件，單次快照上限 8 MiB，合計上限 16 MiB。`room_get_attachment` 可直接回傳 PNG、JPEG、GIF 或 WebP 的 MCP 圖片內容，也可回傳 UTF-8 文字和參照行號。二進位附件提供本機路徑。

每房資料放在 `$SESSION_BRIDGE_HOME/rooms/<room-id>/room.sqlite` 與同層的 `artifacts/`。一般清理保留房間。明確執行 `node src/cli.js prune --rooms-days 30` 才會刪除超過指定天數沒有新增成員或貼文的房間與其附件。

## 設定檔 (`~/.session-bridge/config.json`)

```json
{
  "terminal": {
    "mode": "tab",
    "splitDirection": "auto"
  },
  "defaults": {
    "claude": { "model": null, "effort": null },
    "codex": { "model": null, "effort": null },
    "agy": { "model": null, "effort": null }
  },
  "retention": {
    "tasksDays": 14,
    "doneMessagesDays": 7
  }
}
```

- `terminal.mode`：`tab`（預設，新分頁）、`split`（分割視窗）、`window`（獨立新視窗）。
- `defaults.<provider>`：設定各工具預設 `model` 與 `effort`，派工時未傳入即套用。

## 資料來源

| 工具 | 預設位置 | 覆寫環境變數 |
|------|----------|--------------|
| Claude Code | `~/.claude/projects/<專案>/<id>.jsonl` | `CLAUDE_CONFIG_DIR` |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | `CODEX_HOME` |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` | `AGY_HOME` |

## 測試

```powershell
npm test
```
