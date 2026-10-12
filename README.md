# session-bridge

讓 Codex CLI 與 Claude Code 互相讀取對方對話 session、並互傳訊息的本機 MCP server。不會修改任何 session 檔；訊息另存於 `~/.session-bridge/`。

## 工具

| 工具 | 用途 |
|------|------|
| `list_sessions` | 列出兩邊的 session（新到舊）。預設只列目前專案，`all=true` 涵蓋所有專案 |
| `read_session` | 讀取對話文字；工具呼叫只顯示一行摘要。預設回傳最後 30 則，可用 `offset` / `limit` 分頁 |
| `get_entry` | 以 `[index]` 取得單一則的完整內容（工具呼叫含完整輸入與輸出） |
| `search_sessions` | 在對話文字中搜尋關鍵字（不分大小寫，不含工具輸出） |
| `send_message` | 傳訊息給另一個 session（交接、提問、回報），對方會自動收到並處理 |
| `check_inbox` | 取出某個 Claude Code session 的未讀訊息；平常會自動送達，漏接時才需要 |

`source` 為 `codex` 或 `claude`；`cwd` 請傳入專案目錄的絕對路徑，省略時使用 server 啟動時的工作目錄。

## 使用方式

在任一邊直接用自然語言要求即可，例如：

- 「用 session-bridge 看一下 Codex 在這個專案最後做了什麼，然後接著做」
- 「搜尋 Claude Code 的 session 裡有沒有討論過廣告跳過」

## 訊息傳遞

在任一邊說「把這件事交給 Codex 的 session `<id>`」或「做完後回報給 Claude」即可，agent 會呼叫 `send_message`。

| 方向 | 送達方式 |
|------|----------|
| → Codex CLI | `codex queue` 直接送進該 session：閒置時立刻喚醒，忙碌時排在目前回合之後。session 沒有開著時會留在佇列，下次開啟才處理 |
| → Claude Code | 寫入信箱；Claude 的 `Stop` hook 在回合結束後留在背景等信，信到就喚醒它 |
| 完成回報 | 收到訊息的一方回合結束時，最後一則回覆會自動轉寄給寄件者；已用 `send_message` 主動回覆就不再轉寄 |

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
  "Stop": [{ "hooks": [{ "type": "command", "command": "node", "args": ["C:/path/to/session-bridge/src/hook.js", "claude"], "asyncRewake": true, "timeout": 21700 }] }]
}
```

Codex CLI：建立 `~/.codex/hooks.json`，再到 Codex 內執行 `/hooks` 信任這三個 hook（未信任的 hook 不會執行）：

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/session-bridge/src/hook.js codex", "timeout": 15 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/session-bridge/src/hook.js codex", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node C:/path/to/session-bridge/src/hook.js codex", "timeout": 60 }] }]
  }
}
```

沒有設定 hook 時 `send_message` 仍可把訊息送進 Codex，只是不會有自動回報，Claude 端也要自己呼叫 `check_inbox`。

## 資料來源

| 工具 | 位置 | 覆寫用環境變數 |
|------|------|----------------|
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl`、`~/.codex/session_index.jsonl` | `CODEX_HOME` |
| Claude Code | `~/.claude/projects/<專案>/<id>.jsonl` | `CLAUDE_CONFIG_DIR` |

兩者皆為未公開的內部格式，CLI 改版後若讀不到內容，需調整 `src/codex.js` 或 `src/claude.js`。Codex 的 subagent session 與推理內容（已加密）不會被讀取。

## 安裝

需要 Node.js 22 以上。

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
