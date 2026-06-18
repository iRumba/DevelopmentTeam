import { existsSync, cpSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface InitOptions {
  git: boolean;
  ignore: boolean;
}

/**
 * Resolve the path to the opencode template directory.
 * Works both when installed as a package and during development.
 */
function resolveTemplatePath(): string {
  const candidates = [
    resolve(__dirname, "..", "opencode"),
    resolve(__dirname, "..", "..", "src", "opencode"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  console.error("Error: Could not find DevelopmentTeam template files.");
  console.error("Expected at:", candidates.join(" or "));
  process.exit(1);
}

/**
 * Deploy the development team in the current working directory.
 */
export function runInit(options: InitOptions): void {
  const targetDir = process.cwd();
  const templatePath = resolveTemplatePath();
  const destPath = resolve(targetDir, ".opencode");

  // --- Check if .opencode already exists ---
  if (existsSync(destPath)) {
    console.error(`Error: ${destPath} already exists.`);
    console.error("DevelopmentTeam cannot be deployed over an existing .opencode directory.");
    process.exit(1);
  }

  // --- Check if opencode.jsonc already exists ---
  const configPath = resolve(targetDir, "opencode.jsonc");
  if (existsSync(configPath)) {
    console.error(`Error: ${configPath} already exists.`);
    console.error("DevelopmentTeam cannot be deployed over an existing opencode configuration.");
    process.exit(1);
  }

  // --- Copy template files ---
  console.log("Deploying DevelopmentTeam...");

  // Copy opencode.jsonc to project root
  const sourceConfig = resolve(templatePath, "opencode.jsonc");
  if (existsSync(sourceConfig)) {
    const config = readFileSync(sourceConfig, "utf-8");
    writeFileSync(configPath, config, "utf-8");
    console.log(`  Created ${configPath}`);
  }

  // Copy AGENTS.md to project root
  const sourceAgents = resolve(templatePath, "AGENTS.md");
  if (existsSync(sourceAgents)) {
    const agents = readFileSync(sourceAgents, "utf-8");
    writeFileSync(resolve(targetDir, "AGENTS.md"), agents, "utf-8");
    console.log(`  Created ${resolve(targetDir, "AGENTS.md")}`);
  }

  // Copy .opencode/ directory
  const sourceDotOpen = resolve(templatePath, "dot-opencode");
  if (existsSync(sourceDotOpen)) {
    cpSync(sourceDotOpen, destPath, { recursive: true });
    console.log(`  Created ${destPath}`);
  }

  // --- Git init ---
  if (options.git) {
    try {
      execSync("git init", { cwd: targetDir, stdio: "pipe" });
      console.log("  Initialized git repository");
    } catch {
      console.warn("  Warning: git is not available or git init failed");
    }
  }

  // --- .gitignore ---
  if (options.ignore) {
    const gitignorePath = resolve(targetDir, ".gitignore");
    const entries = [
      "",
      "# DevelopmentTeam — AI agent team files",
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
