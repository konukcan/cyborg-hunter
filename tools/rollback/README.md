# Kill-switches — per-behavior rollbacks for the 0.6.0 runtime changes

Break-glass patches that each undo **exactly one** runtime behavior introduced in
0.6.0, back to its pre-audit state, leaving everything else in 0.6.0 intact. Use one
of these only if a downstream pipeline surfaces a problem with that specific change.

These are **inert patch files**, not commits, on purpose:
- They can never be accidentally merged or shipped.
- Applying one is a single command.
- The keystroke one reintroduces a privacy regression by design — your pre-commit
  codex gate will (correctly) flag it if you ever try to commit it. That flag is a
  feature: this rollback can't happen silently.

Both patches are validated to apply cleanly to the 0.6.0 tree and to reverse-apply
cleanly (round-trip). No node test depends on either behavior (both are runtime/DOM),
so the 123-test suite stays green after applying either.

## The two seams

| Patch | Undoes | Use if… |
|---|---|---|
| `01-restore-keystroke-timing-persistence.patch` | the privacy gate in `monitor.js endTrial()` — raw `editTimestamps` are persisted in every trial again | a pipeline needed `editTimestamps` present by default and the opt-in (`collectForPostHoc.fullKeystrokeTimestamps: true`) isn't viable. **Prefer the opt-in over this patch — it avoids reintroducing the privacy regression cohort-wide.** |
| `02-restore-devtools-keyboardshortcuts-gating.patch` | the `browser.js` toggle change — sidebar/zoom poll gated by `(sidebarGap \|\| devTools)` again, DevTools-hotkey listener by `keyboardShortcuts` alone | a custom signal config relied on the old toggle coupling |

## How to apply one (post-merge, from `main`)

```bash
# 1. apply exactly one rollback
git apply tools/rollback/02-restore-devtools-keyboardshortcuts-gating.patch

# 2. verify + rebuild + ship a patch release
npm test
node build.js
# bump version 0.6.0 -> 0.6.1 (package.json, src/shared/constants.js, CITATION.cff,
# README bibtex + unpkg pin, the 3 extension info.version), add a CHANGELOG note
npm publish
npm deprecate cyborg-hunter@0.6.0 "use 0.6.1"
```

Reverse-apply (undo a rollback you applied locally): `git apply -R <patch>`.

## Notes
- These patches are versioned under `tools/rollback/` but are NOT shipped to npm
  (the package `files` allowlist is `dist/ bin/ src/ README.md`, so `tools/` is
  excluded). They are repo-local break-glass tooling.
- The patches target source lines as of `0.6.0` (`monitor.js` around the typing-speed
  block; `browser.js` around the signal-attach gating). If those files change in a
  later release, regenerate the patch from the relevant commit
  (`9f1682c` introduced both behaviors).
