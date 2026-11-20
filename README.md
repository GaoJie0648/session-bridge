# session-bridge

讓 **Claude Code (`claude`)**、**Codex CLI (`codex`)** 與 **Antigravity CLI (`agy`)** 雙向讀取對話、互傳訊息、並透過前台獨立終端派發協作任務的本機 MCP server。

所有狀態、信箱與設定另存於 `~/.session-bridge/`（可由 `SESSION_BRIDGE_HOME` 覆寫），不直接修改各工具的原始 session 檔案。

## 核心特性 (v0.3)

- **前台獨立終端執行**：`start_task` / `resume_task` 優先透過 Windows Terminal (`wt.exe`) 開啟新分頁或分割視窗執行目標工具的原生互動式 CLI，直接看得到進度並於原生介面處理權限確認與提問；未安裝 `wt` 時退回獨立終端視窗。
- **保留互動 + 自動回報**：目標 CLI 完成交辦回合後分頁維持開啟方便追問或接手，同時透過 `Stop` hook 自動將結果與 token 用量寫入任務並回報發起端。
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
| `start_task` | 在獨立終端開啟指定工具執行任務，支援 `model`、`effort`、`terminal_mode` 與完成自動回報 |
| `resume_task` | 以原 provider（接續原生 session）或切換 provider 開啟新分頁繼續任務 |
| `get_task` / `list_tasks` | 查看任務狀態、對應原生 session id、完成摘要與用量 |
| `get_usage` | 查詢單一任務、單一 session，或近期各工具彙總的 token 用量與本機可得的 rate limit 快照 |

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
