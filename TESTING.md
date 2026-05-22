# Testing

## How to run

```bash
npm test
```

Uses Node's built-in `node:test` runner — zero external dependencies. Discovers and runs every file matching `test/**/*.test.js`.

## What's covered

### `test/openclaw-merge.test.js`

Regression tests for the bundled→runtime `openclaw.json` merge logic in `lib/openclaw-merge.js`. Locks in the fix for the clobber-on-startup bug (commit `032f94e`) where a fresh app boot could overwrite the user's runtime model choice and custom provider entries with bundled template values.

Specifically guards:

- `agents.defaults.model.primary` survives merge (the literal regression case)
- `agents.defaults.bootstrapMaxChars` survives
- User-added custom model entries in `models.providers` survive (e.g. a manually-added `deepseek-v4-pro:cloud`)
- Existing model entries with the same id deep-merge over fresh entries
- New bundled providers pass through when not in existing
- `null` / `undefined` / array values are handled correctly

If you change anything in `lib/openclaw-merge.js` or the merge call sites in `main.js` (`writeOpenClawConfig`), run `npm test` before committing.

## What's NOT covered

This test suite is intentionally narrow — it locks in known-painful regressions, not general coverage. Adding tests for new code paths is welcome, but not required for unrelated changes.

The Electron main process, IPC, gateway lifecycle, and plugin hooks are not unit-tested — those need integration testing with a running Companion. That's a separate effort.
