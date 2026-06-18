#!/usr/bin/env node

import { runInit } from "./commands/init.js";

function showHelp(): void {
  const help = `
DevelopmentTeam — OpenCode AI agent team bootstrap

USAGE
  dev-team <command> [options]

COMMANDS
  init    Deploy the development team in the current directory
  help    Show this help message

OPTIONS FOR init
  --git       Initialize a git repository after deployment
  --ignore    Add DevelopmentTeam files to .gitignore

EXAMPLES
  dev-team init
  dev-team init --git
  dev-team init --git --ignore
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

  const command = args[0];

  if (command === "help" || command === "--help") {
    showHelp();
    process.exit(0);
  }

  if (command === "init") {
    const flags = args.slice(1);
    const git = flags.includes("--git");
    const ignore = flags.includes("--ignore");
    runInit({ git, ignore });
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run `dev-team help` for usage information.");
  process.exit(1);
}

main();
