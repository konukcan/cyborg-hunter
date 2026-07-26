// check-vendor.js
//
// Compares bench/vendor/COMMIT (the SHA the vendored CH dist was built from)
// against the current CH HEAD. Prints a non-fatal warning on drift.
//
// Drift is normal as CH evolves — the warning is informational, not an error.
// Re-vendor by rebuilding dist and copying:
//   node build.js && cp dist/*.js bench/vendor/cyborg-hunter/ \
//     && git rev-parse HEAD > bench/vendor/COMMIT
//
// Designed for testability: getCurrentSha and readCommitFile are injectable.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root sits two levels up from bench/pipeline/.
const DEFAULT_COMMIT_PATH = path.resolve(__dirname, '..', 'vendor', 'COMMIT');

/**
 * Read the vendored SHA from disk and trim whitespace/newlines.
 * Factored out so tests can inject a different reader.
 */
export function readCommitFile(commitPath) {
  return readFileSync(commitPath, 'utf8').trim();
}

/**
 * Resolve the current HEAD via `git rev-parse HEAD`.
 * Factored out so tests can inject a fake SHA without invoking git.
 *
 * `cwd` is pinned to the repo root (two levels up from bench/pipeline/) so
 * invocation from a sibling directory still resolves the CH repo's HEAD.
 * `stdio` ignores stdin and pipes stdout/stderr so git's error output is
 * captured in the thrown error rather than leaking to the user's terminal.
 */
export function getCurrentSha() {
  return execSync('git rev-parse HEAD', {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Core check. Returns { drifted, vendored, current }.
 * Side-effect: writes a warning to `stderr` when drifted.
 *
 * @param {object} [opts]
 * @param {string} [opts.commitPath]   Path to bench/vendor/COMMIT.
 * @param {() => string} [opts.getCurrentSha]  Injectable SHA resolver.
 * @param {() => string} [opts.readCommit]     Injectable commit-file reader.
 * @param {{ write: (s: string) => void }} [opts.stderr]  Injectable stderr.
 */
export function checkVendor({
  commitPath = DEFAULT_COMMIT_PATH,
  getCurrentSha: resolveSha = getCurrentSha,
  readCommit,
  stderr = process.stderr,
} = {}) {
  // check-vendor is advisory: any I/O failure (missing .git, missing COMMIT,
  // detached worktree, permission error) should warn-and-continue rather than
  // crashing the pipeline. We catch around both reads so a single try/catch
  // covers every failure mode.
  let vendored;
  let current;
  try {
    vendored = readCommit
      ? readCommit()
      : readCommitFile(commitPath);
    current = resolveSha();
  } catch (err) {
    stderr.write(
      `warning: could not determine vendor drift (${err.message})\n`
    );
    return { drifted: false, vendored: null, current: null, error: err };
  }

  // Case-insensitive: git SHAs are conventionally lowercase, but be defensive
  // in case the COMMIT file was written/edited with uppercase hex.
  const drifted = vendored.toLowerCase() !== current.toLowerCase();

  if (drifted) {
    const shortV = vendored.slice(0, 7);
    const shortC = current.slice(0, 7);
    stderr.write(
      `warning: bench/vendor/COMMIT (${shortV}) drifted from current HEAD (${shortC}); ` +
        'consider re-vendoring with `cp dist/*.js bench/vendor/cyborg-hunter/ && ' +
        'git rev-parse HEAD > bench/vendor/COMMIT`\n' +
        `  vendored: ${vendored}\n` +
        `  current:  ${current}\n`
    );
  }

  return { drifted, vendored, current };
}

// CLI entry: only runs when this file is invoked directly, not on import.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  checkVendor();
  process.exit(0); // Always 0 — drift is a warning, not a failure.
}
