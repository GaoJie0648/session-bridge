# session-bridge

讓 **Claude Code (`claude`)**、**Codex CLI (`codex`)** 與 **Antigravity CLI (`agy`)** 雙向讀取對話、互傳訊息並派發協作任務的本機 MCP server。

所有狀態、信箱與設定另存於 `~/.session-bridge/`（可由 `SESSION_BRIDGE_HOME` 覆寫），不直接修改各工具的原始 session 檔案。

## 核心特性 (v0.3)

- **背景執行與續接**：Codex 預設使用 App Server，agy 預設使用 ACP。Bridge 記錄原生 session ID、回合結果與可取得的用量，並回報發起端。
- **原生終端與權限確認**：Claude Code 預設使用前台終端。Codex 和 agy 也可以指定 `execution_mode: "terminal"`，在 Windows Terminal 處理登入、權限確認與提問。
- **可插拔 Provider Adapter**：內建 `claude`、`codex`、`agy`，所有 session 讀取、啟動參數、用量解析與 hook 皆由 `src/providers/` 統一抽象。
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
| `start_task` | 啟動協作任務，支援 `model`、`effort`、`execution_mode`、`terminal_mode` 與完成自動回報 |
| `resume_task` | 續接原生 session，或切換 provider 繼續任務 |
| `get_task` / `list_tasks` | 查看任務狀態、對應原生 session id、完成摘要與用量 |
| `get_usage` | 查詢單一任務、單一 session，或近期各工具彙總的 token 用量與本機可得的 rate limit 快照 |

### 執行方式與狀態

- `execution_mode: "managed"` 需要支援 stdio App Server 的 Codex CLI，或支援 ACP v1 的 agy。agy 續接前會檢查 `loadSession` 能力。背景執行時，`get_task` 會顯示原生 session ID 和結果。
- `execution_mode: "terminal"` 或明確指定 `terminal_mode` 會開啟原生終端。續接預設沿用上一次的執行方式，也可以切換。
- Claude Code 請傳入專案的絕對 `cwd`。若任務顯示 `waiting_for_workspace_trust`，請在 Claude Code 終端確認專案。從家目錄啟動的信任確認只維持該次 session。
- 若背景任務回傳 `needs_user_action`，可指定 `execution_mode: "terminal"` 續接，由使用者在原生介面處理登入或權限。`failed` 的 `error` 欄位會顯示啟動或回合錯誤。
- `send_message` 可把訊息排入 agy 信箱。對閒置的 agy 任務，可用背景 `resume_task` 續接原對話並取信。

## 安裝與初始化

需要 Node.js 22 以上。直接以 `init` 一次完成三個工具的 MCP Server 註冊、Hook 安裝與 `~/.session-bridge/config.json` 初始化（不再需要手動各別設定 `npx`、`cmd /c` 或 `MSYS_NO_PATHCONV`）：

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
