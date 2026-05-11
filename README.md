# n8n Workflows

A personal collection of n8n automation workflows, built with AI assistance using Claude Code.

## Setup

This repository is paired with two tools that give Claude expert-level knowledge of n8n when generating or reviewing workflows:

### n8n-MCP Server
[czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp) — an MCP server that exposes structured documentation for all 1,650+ n8n nodes directly inside Claude Code. This allows Claude to look up correct node properties, operations, and configuration options instead of guessing.

Configured in `~/.claude/settings.json` via:
```json
"mcpServers": {
  "n8n-mcp": {
    "command": "npx",
    "args": ["-y", "n8n-mcp"]
  }
}
```

### n8n-Skills Plugin
[czlonkowski/n8n-skills](https://github.com/czlonkowski/n8n-skills) — a Claude Code plugin with 7 expert skills covering expression syntax, workflow patterns, node configuration, validation, and JavaScript/Python code generation. The skills activate automatically when working on n8n-related tasks.

## Structure

Workflows will be organized by use case as they are added.

## Notes

- Never deploy AI-generated workflows directly to production — always test in a development environment first and export a backup beforehand.
