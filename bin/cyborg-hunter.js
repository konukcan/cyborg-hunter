#!/usr/bin/env node
// CLI entry point for Cyborg Hunter.
// Usage:
//   npx cyborg-hunter init                       # generate starter config
//   npx cyborg-hunter report [--config path] ...  # generate report

import { readFileSync } from 'node:fs';
import { run } from '../src/cli/report.js';
import { runInit } from '../src/cli/init.js';

const args = process.argv.slice(2);
const subcommand = args[0];

// Printed on unexpected crashes only; deliberate exits (like the no-data
// guidance in report.js) call process.exit directly and never reach it.
function crash(err) {
  console.error('Error:', err.message);
  console.error('\nIf this looks like a bug, please report it at');
  console.error('  https://github.com/cyborg-hunter/cyborg-hunter/issues');
  console.error('(include the command, the error, and your version; never include participant data)');
  process.exit(1);
}

if (subcommand === '--version' || subcommand === '-v') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else if (subcommand === 'init') {
  runInit().catch(crash);
} else if (subcommand === 'report' || !subcommand) {
  run(args).catch(crash);
} else {
  console.error(`Unknown command: ${subcommand}. Use "report", "init", or "--version".`);
  process.exit(1);
}
