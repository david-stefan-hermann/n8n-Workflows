# n8n Workflows

A personal collection of n8n automation workflows for [avernus.cloud](https://n8n.avernus.cloud), built with AI assistance using Claude Code.

---

## Workflows

### Email → Calendar + AFFiNE Todos

**Trigger:** Every new email (Gmail Trigger, polling every minute)

Processes each incoming email with Claude Haiku 4.5 and routes relevant information to the right place automatically.

```
Gmail Trigger
    └─► Claude Haiku 4.5 (analysis)
            ├─► Has appointment? ──► Google Calendar (create event)
            └─► Has todo?        ──► AFFiNE (append under "Email Todos" h2)
```

**What gets a calendar entry:**
- Any email proposing a specific date and time for a meeting or event

**What gets a todo entry:**
- Shipping confirmations with tracking number
- Invoices and receipts
- Reservations (hotel, flight, restaurant, tickets)
- Replies explicitly needed
- Registrations and deadlines
- Login credentials or important documents received
- HTW Berlin: course cancellations, online/hybrid changes, assignment deadlines, exam registrations, grade entries, re-enrollment deadlines

**What is intentionally ignored:**
- Sent emails (no self-todos)
- HTW Berlin social events, job postings, general announcements
- Newsletters and marketing emails

**Todo format:**
- Emoji-prefixed single item in German: `📦 Paket: Amazon – AirPods (DE123456789) [empfangen: 11.05.2026 20:50]`
- Optional nested sub-items for complex multi-step actions
- Always appended under the `## Email Todos` heading in the target AFFiNE page

---

## Infrastructure

### AFFiNE Todo Bridge

A small Node.js service ([`affine-todo-bridge/`](affine-todo-bridge/)) that translates n8n HTTP requests into Yjs document updates for AFFiNE.

See [`affine-todo-bridge/README.md`](affine-todo-bridge/README.md) for deployment and the full AFFiNE API findings.

---

## Setup

### Tools installed globally

| Tool | Purpose | Config |
|---|---|---|
| [n8n-mcp](https://github.com/czlonkowski/n8n-mcp) | MCP server with docs for all 1,650+ n8n nodes | `~/.claude/settings.json` |
| [n8n-mcp-skills](https://github.com/czlonkowski/n8n-skills) | 7 Claude Code skills for n8n workflow building | `~/.claude/settings.json` |

### Services

| Service | URL |
|---|---|
| n8n | [n8n.avernus.cloud](https://n8n.avernus.cloud) |
| AFFiNE | [affine.avernus.cloud](https://affine.avernus.cloud) |
| AFFiNE Todo Bridge | Internal Docker network, port 30170 |

### Required credentials in n8n

- Gmail OAuth2
- Google Calendar OAuth2
- Anthropic API key (Claude Haiku 4.5)
