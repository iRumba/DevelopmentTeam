import {
  existsSync,
  cpSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { parse as parseJsoncSafe } from "jsonc-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface InitOptions {
  git: boolean;
  ignore: boolean;
  force: boolean;
}

// ── Template resolution ──────────────────────────────────────────────────

function resolveTemplatePath(): string {
  // Check installed mode first (dist/opencode/), then dev mode (src/opencode/)
  const candidates = [
    resolve(__dirname, "..", "opencode"),
    resolve(__dirname, "..", "..", "src", "opencode"),
  ];

  for (const candidate of candidates) {
    const configPath = resolve(candidate, "opencode.jsonc");
    if (existsSync(candidate) && existsSync(configPath)) {
      return candidate;
    }
  }

  console.error("Error: Could not find DevelopmentTeam template files.");
  console.error("Expected at:", candidates.join(" or "));
  console.error("Make sure the package is properly installed.");
  process.exit(1);
}

// ── File enumeration ────────────────────────────────────────────────────

interface TemplateFile {
  /** Relative path from project root (e.g., ".opencode/agents/build.md") */
  relativePath: string;
  /** Absolute source path in template */
  sourcePath: string;
  /** Absolute destination path in target project */
  destPath: string;
  /** Category for merge logic */
  category: "root-config" | "root-doc" | "agent" | "skill" | "plugin" | "command" | "tool" | "other";
}

/**
 * Recursively enumerate all files in a directory with their relative paths.
 */
function enumerateFiles(dir: string, prefix: string = ""): TemplateFile[] {
  const results: TemplateFile[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(...enumerateFiles(fullPath, relPath));
    } else {
      const category = determineCategory(relPath);
      results.push({
        relativePath: relPath,
        sourcePath: fullPath,
        destPath: fullPath, // will be resolved to target later
        category,
      });
    }
  }
  return results;
}

function determineCategory(relPath: string): TemplateFile["category"] {
  if (relPath === "opencode.json" || relPath === "opencode.jsonc") return "root-config";
  if (relPath === "AGENTS.md") return "root-doc";
  if (relPath.startsWith("agents/")) return "agent";
  if (relPath.startsWith("skills/")) return "skill";
  if (relPath.startsWith("plugins/")) return "plugin";
  if (relPath.startsWith("commands/")) return "command";
  if (relPath.startsWith("tools/")) return "tool";
  return "other";
}

// ── Conflict detection ──────────────────────────────────────────────────

interface ConflictReport {
  hasConflicts: boolean;
  files: {
    relativePath: string;
    category: TemplateFile["category"];
    action: "overwrite" | "merge-config" | "merge-package";
  }[];
}

function scanConflicts(templatePath: string, targetDir: string): ConflictReport {
  const conflicts: ConflictReport["files"] = [];

  // Check root-level template files
  const rootEntries = readdirSync(templatePath, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === "dot-opencode") continue;
    const relPath = entry.name;
    const destPath = resolve(targetDir, relPath);
    if (existsSync(destPath)) {
      const category = determineCategory(relPath);
      conflicts.push({
        relativePath: relPath,
        category,
        action: category === "root-config" ? "merge-config" : "overwrite",
      });
    }
  }

  // Also detect opencode.json (old format — template only has .jsonc)
  const jsonConfigPath = resolve(targetDir, "opencode.json");
  if (existsSync(jsonConfigPath)) {
    // Only add if not already detected via opencode.jsonc
    const alreadyDetected = conflicts.some(c => c.relativePath === "opencode.jsonc" || c.relativePath === "opencode.json");
    if (!alreadyDetected) {
      conflicts.push({
        relativePath: "opencode.json",
        category: "root-config",
        action: "merge-config",
      });
    }
  }

  // Check dot-opencode/ files against target's .opencode/
  const dotOpenSrc = resolve(templatePath, "dot-opencode");
  if (existsSync(dotOpenSrc)) {
    const templateFiles = enumerateFiles(dotOpenSrc);
    for (const tf of templateFiles) {
      const destPath = resolve(targetDir, ".opencode", tf.relativePath);
      if (existsSync(destPath)) {
        conflicts.push({
          relativePath: `.opencode/${tf.relativePath}`,
          category: tf.category,
          action: (["root-config", "root-doc"].includes(tf.category))
            ? "merge-config"
            : "overwrite",
        });
      }
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    files: conflicts,
  };
}

// ── Backup ──────────────────────────────────────────────────────────────

function backupConflictingFiles(conflicts: ConflictReport["files"], targetDir: string): string {
  const backupDir = resolve(targetDir, ".opencode.old");
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  for (const conflict of conflicts) {
    const sourcePath = resolve(targetDir, conflict.relativePath);
    const backupPath = resolve(backupDir, conflict.relativePath);
    const backupDirPath = dirname(backupPath);
    if (!existsSync(backupDirPath)) {
      mkdirSync(backupDirPath, { recursive: true });
    }
    // Use copy for safety — the original will be overwritten later
    cpSync(sourcePath, backupPath, { recursive: false, errorOnExist: false });
    console.log(`  Backed up: ${conflict.relativePath} -> .opencode.old/`);
  }

  return backupDir;
}

// ── JSON/JSONC helpers ──────────────────────────────────────────────────

/**
 * Parse JSON or JSONC text into an object.
 * Uses jsonc-parser which correctly handles // in URLs, comments, and trailing commas.
 */
function parseJsonc(text: string): Record<string, unknown> {
  const result = parseJsoncSafe(text);
  if (result === undefined) {
    throw new Error("Failed to parse JSON/JSONC: result is undefined (file may be empty or invalid)");
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Expected JSON/JSONC root to be an object");
  }
  return result as Record<string, unknown>;
}

/**
 * Deep merge opencode configuration.
 * Rules:
 * - agents: overwrite agents with same names, keep others
 * - permissions: overwrite
 * - instructions: append ours, warn about conflicts
 * - mcp: add ours if not already present
 * - plugin: add ours if not already present
 * - everything else: keep existing
 */
function mergeOpencodeConfig(templateText: string, existingText: string): string {
  const template = parseJsonc(templateText);
  const existing = parseJsonc(existingText);

  // Merge top-level keys
  const result: Record<string, unknown> = { ...existing };

  // Agents: overwrite matching names, keep non-matching
  if (template.agents && typeof template.agents === "object" && !Array.isArray(template.agents)) {
    const templateAgents = template.agents as Record<string, unknown>;
    if (!result.agents || typeof result.agents !== "object" || Array.isArray(result.agents)) {
      result.agents = {};
    }
    const existingAgents = result.agents as Record<string, unknown>;
    for (const [name, config] of Object.entries(templateAgents)) {
      if (existingAgents[name]) {
        console.log(`    Agent "${name}" will be overwritten with DevelopmentTeam version`);
      }
      existingAgents[name] = config;
    }
  }

  // Permissions: overwrite with ours
  if (template.permission) {
    console.log("    Permissions will be overwritten with DevelopmentTeam defaults");
    result.permission = template.permission;
  }

  // MCP: add ours if not present
  if (template.mcp && typeof template.mcp === "object" && !Array.isArray(template.mcp)) {
    const templateMcp = template.mcp as Record<string, unknown>;
    if (!result.mcp || typeof result.mcp !== "object" || Array.isArray(result.mcp)) {
      result.mcp = {};
    }
    const existingMcp = result.mcp as Record<string, unknown>;
    for (const [name, config] of Object.entries(templateMcp)) {
      if (!existingMcp[name]) {
        existingMcp[name] = config;
      }
    }
  }

  // Plugins: append ours if not already present
  if (Array.isArray(template.plugin)) {
    if (!Array.isArray(result.plugin)) {
      result.plugin = [];
    }
    const existingPlugins = result.plugin as string[];
    const templatePlugins = template.plugin as string[];
    for (const p of templatePlugins) {
      if (!existingPlugins.includes(p)) {
        existingPlugins.push(p);
      }
    }
  }

  // Instructions: append ours, warn
  if (Array.isArray(template.instructions)) {
    const existingInstructions = Array.isArray(result.instructions)
      ? (result.instructions as string[])
      : [];
    const templateInstructions = template.instructions as string[];
    const newInstructions = templateInstructions.filter(
      (i: string) => !existingInstructions.includes(i)
    );
    if (newInstructions.length > 0) {
      console.log("  Warning: Existing instructions may conflict with DevelopmentTeam team behavior.");
      console.log(`      DevelopmentTeam adds: ${newInstructions.join(", ")}`);
      result.instructions = [...existingInstructions, ...newInstructions];
    }
  }

  // Return the merged result as formatted JSON
  return JSON.stringify(result, null, 2) + "\n";
}

// ── Main ────────────────────────────────────────────────────────────────

export function runInit(options: InitOptions): void {
  const targetDir = process.cwd();
  const templatePath = resolveTemplatePath();

  // ── Phase 1: Scan conflicts ──
  console.log("Scanning for existing files...");
  const conflictReport = scanConflicts(templatePath, targetDir);

  if (conflictReport.hasConflicts) {
    console.log("\nThe following files already exist and will be affected:\n");
    for (const cf of conflictReport.files) {
      const actionLabel =
        cf.action === "overwrite" ? "OVERWRITE" :
        cf.action === "merge-config" ? "MERGE" :
        "MERGE";
      console.log(`  [${actionLabel}] ${cf.relativePath}`);
    }

    if (!options.force) {
      console.log("\nUse --force to proceed with automatic backup and merge.");
      console.log("  dev-team init --force [--git] [--ignore]");
      process.exit(1);
    }

    // Phase 2: Backup
    console.log("\nCreating backup in .opencode.old/ ...");
    const backupDir = backupConflictingFiles(conflictReport.files, targetDir);
    console.log(`  Backup created at ${backupDir}`);
  }

  // ── Phase 3: Handle opencode config merge ──
  const configConflict = conflictReport.files.find(
    (f) => f.category === "root-config"
  );

  const configDest = resolve(targetDir, "opencode.jsonc");

  if (configConflict) {
    // Collect all existing config files
    const existingConfigs: { path: string; content: string }[] = [];

    const jsoncPath = resolve(targetDir, "opencode.jsonc");
    const jsonPath = resolve(targetDir, "opencode.json");

    if (existsSync(jsoncPath)) {
      existingConfigs.push({ path: jsoncPath, content: readFileSync(jsoncPath, "utf-8") });
    }
    if (existsSync(jsonPath)) {
      existingConfigs.push({ path: jsonPath, content: readFileSync(jsonPath, "utf-8") });
    }

    if (existingConfigs.length > 0) {
      console.log("  Merging opencode configuration...");
      const templateConfig = readFileSync(resolve(templatePath, "opencode.jsonc"), "utf-8");

      // If multiple existing configs, merge them together first
      let existingContent: string;
      if (existingConfigs.length === 1) {
        existingContent = existingConfigs[0].content;
      } else {
        // Merge existing: jsonc takes priority over json
        const jsonObj = parseJsonc(existingConfigs.find(c => c.path.endsWith(".json"))?.content || "{}");
        const jsoncObj = parseJsonc(existingConfigs.find(c => c.path.endsWith(".jsonc"))?.content || "{}");
        const mergedExisting = { ...jsonObj, ...jsoncObj };
        existingContent = JSON.stringify(mergedExisting, null, 2);
      }

      const merged = mergeOpencodeConfig(templateConfig, existingContent);
      writeFileSync(configDest, merged, "utf-8");
      console.log(`  Created ${configDest} (merged)`);

      // Delete non-.jsonc config files (already backed up in .opencode.old/)
      for (const ec of existingConfigs) {
        if (ec.path !== configDest) {
          unlinkSync(ec.path);
        }
      }
    }
  }

  // ── Phase 4: Deploy root-level template files ──
  // Deploy all root-level files (AGENTS.md, etc.) except opencode.jsonc which was already merged
  const rootEntries = readdirSync(templatePath, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === "dot-opencode") continue;
    if (!entry.isFile()) continue;
    // If we merged config, skip opencode.jsonc — already handled
    if (configConflict && entry.name === "opencode.jsonc") continue;
    const src = resolve(templatePath, entry.name);
    const dst = resolve(targetDir, entry.name);
    const content = readFileSync(src, "utf-8");
    writeFileSync(dst, content, "utf-8");
    console.log(`  Created ${dst}`);
  }

  // ── Phase 5: Merge package.json ──
  const pkgDest = resolve(targetDir, "package.json");
  if (existsSync(pkgDest)) {
    console.log("  Merging package.json dependencies...");
    try {
      const existingPkg = JSON.parse(readFileSync(pkgDest, "utf-8"));
      const templatePkgPath = resolve(templatePath, "dot-opencode", "plugins", "package.json");
      if (existsSync(templatePkgPath)) {
        const templatePkg = JSON.parse(readFileSync(templatePkgPath, "utf-8"));
        if (templatePkg.dependencies) {
          existingPkg.dependencies = {
            ...(existingPkg.dependencies || {}),
            ...templatePkg.dependencies,
          };
          writeFileSync(pkgDest, JSON.stringify(existingPkg, null, 2) + "\n", "utf-8");
          console.log(`  Updated ${pkgDest} with DevelopmentTeam dependencies`);
        }
      }
    } catch {
      console.warn("  Warning: Could not parse existing package.json, skipping merge");
    }
  }

  // ── Phase 6: Deploy .opencode/ files (overwrite agents, skills, plugins, etc.) ──
  const dotOpenSrc = resolve(templatePath, "dot-opencode");
  const dotOpenDst = resolve(targetDir, ".opencode");
  if (existsSync(dotOpenSrc)) {
    cpSync(dotOpenSrc, dotOpenDst, { recursive: true, force: true });
    console.log(`  Updated ${dotOpenDst}`);
  }

  // ── Phase 7: Install dependencies ──
  const pluginsPackageJson = resolve(dotOpenDst, "plugins", "package.json");
  if (existsSync(pluginsPackageJson)) {
    console.log("  Installing jsonc MCP server dependencies...");
    try {
      execSync("npm install", { cwd: resolve(dotOpenDst, "plugins"), stdio: "pipe" });
      console.log("  Installed jsonc MCP dependencies");
    } catch {
      console.warn("  Warning: npm install failed in .opencode/plugins/ -- jsonc MCP may not work");
    }
  }

  // ── Phase 8: Git init ──
  if (options.git) {
    try {
      execSync("git init", { cwd: targetDir, stdio: "pipe" });
      console.log("  Initialized git repository");
    } catch {
      console.warn("  Warning: git is not available or git init failed");
    }
  }

  // ── Phase 9: .gitignore ──
  if (options.ignore) {
    const gitignorePath = resolve(targetDir, ".gitignore");
    const entries = [
      "",
      "# DevelopmentTeam -- AI agent team files",
      ".opencode/",
      "opencode.jsonc",
      "AGENTS.md",
      "",
    ];
    try {
      appendFileSync(gitignorePath, entries.join("\n"), "utf-8");
      console.log(`  Updated ${gitignorePath}`);
    } catch {
      console.warn("  Warning: could not update .gitignore");
    }
  }

  console.log("\nDevelopmentTeam deployed successfully!");
  console.log("Restart opencode to activate the team.");
}

export function showHelp(): void {
  console.log(`Usage: dev-team [command] [options]

Commands:
  init        Deploy DevelopmentTeam in the current directory
  help        Show this help message

Options for init:
  --git       Initialize a git repository after deployment
  --ignore    Add team files to .gitignore (use with --git)
  --force     Overwrite existing files (creates backup in .opencode.old/)

Examples:
  dev-team init
  dev-team init --git
  dev-team init --force --git --ignore
`);
}
