# session-bridge

讓 Codex CLI 與 Claude Code 互相讀取對方對話 session 的本機 MCP server。唯讀，不會修改任何 session 檔。

## 工具

| 工具 | 用途 |
|------|------|
| `list_sessions` | 列出兩邊的 session（新到舊）。預設只列目前專案，`all=true` 涵蓋所有專案 |
| `read_session` | 讀取對話文字；工具呼叫只顯示一行摘要。預設回傳最後 30 則，可用 `offset` / `limit` 分頁 |
| `get_entry` | 以 `[index]` 取得單一則的完整內容（工具呼叫含完整輸入與輸出） |
| `search_sessions` | 在對話文字中搜尋關鍵字（不分大小寫，不含工具輸出） |

`source` 為 `codex` 或 `claude`；`cwd` 請傳入專案目錄的絕對路徑，省略時使用 server 啟動時的工作目錄。

## 使用方式

在任一邊直接用自然語言要求即可，例如：

- 「用 session-bridge 看一下 Codex 在這個專案最後做了什麼，然後接著做」
- 「搜尋 Claude Code 的 session 裡有沒有討論過廣告跳過」

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

只會讀取執行所在機器的 session，不會跨機器同步。

移除：`claude mcp remove session-bridge -s user`、`codex mcp remove session-bridge`。

## 測試

```powershell
npm test
```
