# DevelopmentTeam Implementation Plan

## Goal
Create a deployable opencode AI development team as an npm-installable CLI tool `dev-team`.

## Architecture

```
DevelopmentTeam/
├── package.json          # npm package with bin "dev-team"
├── tsconfig.json         # TypeScript configuration
├── README.md             # User documentation
├── plan.md               # This document
├── .gitignore            # Project-level ignore
├── tmp/                  # Temporary directory
├── src/
│   ├── index.ts          # CLI entry point
│   ├── commands/
│   │   └── init.ts       # dev-team init command
│   └── opencode/         # Template deployed to user's project
│       ├── opencode.jsonc    # → project root/opencode.jsonc
│       ├── AGENTS.md         # → project root/AGENTS.md
│       ├── env_defaults.json # → project root/.opencode/env_defaults.json
│       └── dot-opencode/    # → project root/.opencode/
│           ├── .gitignore
│           ├── agents/          # 8 agent definitions
│           ├── skills/          # 7 skill directories
│           ├── commands/
│           │   └── review.md
│           ├── tools/
│           │   └── philosophy.md
│           └── plugins/
│               └── jsonc-mcp-server.cjs
```

## Phases

### Phase 1: Project Scaffold [COMPLETE]
- Directory structure, package.json, tsconfig, .gitignore
- CLI entry point (src/index.ts)
- Init command (src/commands/init.ts)

### Phase 2: OpenCode Template — Config & Agents [COMPLETE]
- opencode.jsonc (main config with 8 agents, MCP, permissions)
- AGENTS.md (team documentation)
- env_defaults.json, .gitignore, tools/philosophy.md, commands/review.md
- All 8 agent files (build, plan, coder, scribe, reviewer, researcher, explorer, secrets-manager)

### Phase 3: OpenCode Template — Skills [COMPLETE]
- All 7 skills: code-philosophy, frontend-philosophy, code-review, plan-protocol, plan-review, secrets-guidelines, json-manipulation

### Phase 4: MCP & Plugins [COMPLETE]
- jsonc-mcp-server.cjs

### Phase 5: Documentation & Repository [COMPLETE]
- README.md, plan.md
- Build verification
- GitHub repository

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| No gitverse references | User requirement |
| All prompts in English | User requirement |
| Orchestrator delegates all file reads to `explorer` | User requirement to fix anti-pattern |
| Separate `explorer.md` agent file | Previously inline config — now a proper agent |
| npm package with `bin` | Standard CLI distribution |
| Template in `src/opencode/` | Separates CLI code from deployable template |
