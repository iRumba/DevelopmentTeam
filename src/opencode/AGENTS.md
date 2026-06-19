# DevelopmentTeam — AI Agent Team

This project uses an opencode AI agent team for development. The team is orchestrated by the `build` agent, which delegates work to specialized agents.

## Agent Roles

| Agent | Mode | Responsibility |
|-------|------|---------------|
| `build` | primary | Orchestrator — delegates, never implements directly |
| `plan` | primary | Creates implementation plans |
| `coder` | subagent | Writes and modifies code |
| `scribe` | subagent | Creates documentation and prose |
| `reviewer` | subagent | Reviews code for quality |
| `researcher` | subagent | External research (APIs, docs, libraries) |
| `explorer` | subagent | Codebase analysis and exploration |
| `secrets-manager` | subagent | Manages API keys and secrets |

## Philosophy

Before writing any code, agents MUST load the relevant philosophy skill:
- Backend/logic → `code-philosophy` (5 Laws of Elegant Defense)
- Frontend/UI → `frontend-philosophy` (5 Pillars of Intentional UI)

## Routing Rules

- Codebase questions → delegate to `explorer`
- External API/docs → delegate to `researcher`
- Code changes → delegate to `coder`
- Documentation → delegate to `scribe`
- Code review → delegate to `reviewer`

## Built-In Plugins

| Plugin | Description |
|--------|-------------|
| `workspace-plugin` | Plan management with save/read, coder task tracking, review reminders, plan persistence across compaction |
| `background-agents` | Async delegation system — allows parallel background work with persistent, retrievable output |
| `notify` | Native OS desktop notifications and terminal title updates |
| `worktree` | Git worktree session isolation — create, manage, and track worktree branches |
