#!/usr/bin/env node

import { runInit } from "./commands/init.js";

export interface CliOptions {
  command?: string;
  git: boolean;
  ignore: boolean;
  force: boolean;
}

function parseArgs(args: string[]): CliOptions | { error: true; message: string } {
  const options: CliOptions = { git: false, ignore: false, force: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--git") {
      options.git = true;
    } else if (arg === "--ignore") {
      options.ignore = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg.startsWith("--")) {
      return { error: true, message: `Unknown option: ${arg}` };
    } else if (!options.command) {
      options.command = arg;
    } else {
      return { error: true, message: `Unexpected argument: ${arg}` };
    }
  }

  return options;
}

function showHelp(): void {
  const help = `
DevelopmentTeam -- OpenCode AI agent team bootstrap

USAGE
  dev-team <command> [options]

COMMANDS
  init    Deploy the development team in the current directory
  help    Show this help message

OPTIONS FOR init
  --git       Initialize a git repository after deployment
  --ignore    Add DevelopmentTeam files to .gitignore
  --force     Overwrite existing files (creates backup in .opencode.old/)

EXAMPLES
  dev-team init
  dev-team init --git
  dev-team init --git --ignore
  dev-team init --force --git --ignore
  dev-team help
`;
  console.log(help);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const parsed = parseArgs(args);

  if ("error" in parsed) {
    console.error(parsed.message);
    process.exit(1);
  }

  if (parsed.command === "help" || parsed.command === "--help" || !parsed.command) {
    showHelp();
    process.exit(0);
  }

  if (parsed.command === "init") {
    runInit({ git: parsed.git, ignore: parsed.ignore, force: parsed.force });
    return;
  }

  console.error(`Unknown command: ${parsed.command}`);
  console.error("Run `dev-team help` for usage information.");
  process.exit(1);
}

main();
