# DevelopmentTeam

**An opencode AI agent development team — deployable via a single CLI command.**

DevelopmentTeam provides a complete, production-ready team of AI agents for opencode. Run `dev-team init` in any project to bootstrap an orchestrated development team with specialized agents for planning, coding, reviewing, researching, exploring, documenting, and managing secrets — all guided by built-in philosophical principles.

## Installation

### Option 1: Local install (recommended)

```bash
# Clone the repository
git clone https://github.com/iRumba/DevelopmentTeam.git
cd DevelopmentTeam

# Install dependencies and build
npm install
npm run build

# Install globally from local directory
npm install -g .

# Now you can use `dev-team` anywhere
dev-team help
```

### Option 2: Direct from GitHub

```bash
# Install directly from GitHub
npm install -g https://github.com/iRumba/DevelopmentTeam.git

# Now you can use `dev-team` anywhere
dev-team help
```

### Option 3: Via npx (no install)

```bash
npx https://github.com/iRumba/DevelopmentTeam.git help
```

## Usage

```bash
# Deploy the development team in the current directory
dev-team init

# Deploy and initialize a git repository
dev-team init --git

# Deploy, init git, and add team files to .gitignore
dev-team init --git --ignore

# Show help
dev-team help
```

## What You Get

Running `dev-team init` creates:
- `opencode.jsonc` — Complete configuration with 8 agents, MCP servers, and permissions
- `AGENTS.md` — Team documentation and routing rules
- `.opencode/agents/` — 8 specialized agents for every development role
- `.opencode/skills/` — 7 philosophical principles and review protocols
- `.opencode/tools/philosophy.md` — Mandatory philosophy loading instruction
- `.opencode/commands/review.md` — Code review command
- `.opencode/plugins/jsonc-mcp-server.cjs` — JSON/JSONC manipulation MCP server

## Agent Team

| Agent | Mode | Responsibility |
|-------|------|----------------|
| `build` | primary | Orchestrates the team — delegates, never implements |
| `plan` | primary | Creates implementation plans with research and citations |
| `coder` | subagent | Writes and modifies code following philosophy guidelines |
| `scribe` | subagent | Creates documentation, commit messages, and human-facing prose |
| `reviewer` | subagent | Reviews code and plans with 4-layer analysis and confidence thresholds |
| `researcher` | subagent | External research — documentation, APIs, npm packages |
| `explorer` | subagent | Codebase analysis — file search, pattern matching, flow tracing |
| `secrets-manager` | subagent | API key and secret management with cascading resolution |

## Built-In Skills

- **code-philosophy** — The 5 Laws of Elegant Defense (Early Exit, Parse Don't Validate, Atomic Predictability, Fail Fast, Intentional Naming)
- **frontend-philosophy** — The 5 Pillars of Intentional UI (Typography, Color, Motion, Composition, Atmosphere)
- **code-review** — 4-layer review methodology with severity classification and ≥80% confidence threshold
- **plan-protocol** — Implementation plan formatting and citation standards
- **plan-review** — Plan quality assessment criteria
- **secrets-guidelines** — Secret management rules and documentation standards
- **json-manipulation** — Safe JSON/JSONC file manipulation via MCP tools

## Orchestrator Architecture

The `build` agent acts as the team orchestrator. It:
1. **Never reads files directly** — delegates codebase analysis to `explorer`
2. **Never edits files** — delegates implementation to `coder`
3. **Never runs commands** — delegates execution to `coder`
4. **Never researches externally** — delegates to `researcher`
5. **Always requests review** — delegates to `reviewer` before reporting completion

## Requirements

- [opencode](https://opencode.ai) installed
- Node.js >= 18
- For GitHub MCP: `GITHUB_TOKEN` environment variable set

## Development

```bash
# Clone and prepare
git clone https://github.com/iRumba/DevelopmentTeam.git
cd DevelopmentTeam
npm install
npm run build

# Test locally
node ./dist/index.js init --git
```

## Restart Required

After running `dev-team init`, quit and restart opencode for the configuration to take effect.

## License

MIT
