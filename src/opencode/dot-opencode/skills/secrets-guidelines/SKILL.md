---
name: secrets-guidelines
description: Rules for managing project secrets — what, where, how to document, and what NOT to store in repos
---

# Secrets Management Guidelines

> **Load this skill** when setting up project secrets, creating .env.example, documenting secrets in secrets.md, or auditing secret storage.

## When to Use
1. Setting up a new project — configuring secret storage strategy
2. Creating .env.example for developers
3. Documenting secrets in docs/technical/secrets.md
4. Auditing whether secrets are properly excluded from version control

---

## Golden Rule

**Secrets are NEVER stored in plain text.** Nowhere:
- ❌ In the repository (code, configs, documentation, commits)
- ❌ In files on disk (`.env`, `secrets.json`, `credentials.ini`, etc.)
- ❌ In environment variables written to files
- ❌ In shared folders, templates, docker-compose files

The only legal exception — local `.env` for development, **only** if:
- File is in project `.gitignore`
- Created by developer manually from `.env.example`
- Not synced between devices or shared with the team

---

## Secrets Belong to Environments

Each secret is tied to a specific environment:

| Environment | Where Secrets Are Stored |
|-------------|--------------------------|
| Local development | `.env` (created from `.env.example`) |
| CI/CD | CI/CD platform env vars (GitHub Actions Secrets, GitLab CI Variables) |
| Staging | Secret manager (Vault, AWS Secrets Manager, .env via CI/CD) |
| Production | Secret manager (Vault, AWS Secrets Manager, Kubernetes Secrets) |

Secrets **are not a project artifact**. They belong to infrastructure and environment. When moving to different infrastructure, secrets are created fresh, not copied.

---

## Documenting Secrets

Information about secrets goes in `docs/technical/secrets.md`. This file contains **only descriptions** of what secrets are needed:

- Environment variable names (e.g., `DB_PASSWORD`, `KAFKA_API_KEY`)
- Which tool/module it's for
- Which environment needs it (dev/staging/prod)
- Where to get it (link to secret manager, admin panel, SaaS panel)
- Example value (with placeholders, no real data)

**❌ Forbidden** to put real secret values in `secrets.md`.

---

## .env.example Template

The `.env.example` file **may** be stored in the repository, but:
- All values — only placeholders (`your_password_here`, `your_api_key_here`)
- No real data
- No default values that are secrets

---

## What NOT to Include in secrets.md

`docs/technical/secrets.md` contains **only project secrets** — what's needed to run the app (DB passwords, external API keys, integration tokens).

**Do NOT include:**
- ❌ Platform access tokens (GITVERSE_TOKEN, GITHUB_TOKEN) — that's team infrastructure, not project
- ❌ CI/CD environment variables — they belong to the build environment
- ❌ Personal developer keys — personal secrets

Such meta-info belongs in **DevelopmentTeam metadata** (`~/.config/opencode/DevelopmentTeam/`), not in the project.

If the project uses no external services with secrets, still create `secrets.md` with:
```markdown
# Project Secrets

Currently the project does not use any external services requiring secrets.
If API keys, tokens, or passwords are added in the future, they will be documented here.
```

---

## secrets-manager Agent

The team has a `secrets-manager` agent for secret operations.
Local definition: `.opencode/agents/secrets-manager.md`, database: `.opencode/secrets-db.json`.

**When to delegate to `secrets-manager`:**
- Get a secret value (API key, token, password)
- Register a new secret in the registry
- Check if a secret exists
- Show list of registered secrets
- Add existing env var to secret registry

**Important:** If `secrets-manager` is available in the current session, all secret operations **must be delegated to it**. Do not read, write, or manage secrets directly.
