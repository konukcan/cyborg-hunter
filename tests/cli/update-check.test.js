// Update nudge: the registry check must be fail-silent, throttled, and
// opt-out-able; the collected-with notice must fire only on a real mismatch.
// Everything impure is injected — no test touches the network or $HOME.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  compareVersions,
  checkForUpdate,
  formatUpdateNotice,
  formatCollectedVersionNotice,
} from '../../src/cli/update-check.js';
import { extractIntegrityData } from '../../src/cli/extract-core.js';

function okFetch(version) {
  return async () => ({ ok: true, json: async () => ({ version }) });
}

describe('compareVersions', () => {
  it('orders numeric dot segments, including double digits', () => {
    assert.equal(compareVersions('0.10.0', '0.7.2'), 1);
    assert.equal(compareVersions('0.7.2', '0.7.2'), 0);
    assert.equal(compareVersions('0.7.1', '0.7.2'), -1);
    assert.equal(compareVersions('1.0', '0.9.9'), 1);
  });

  it('treats malformed segments as 0, so garbage never nudges', () => {
    assert.equal(compareVersions('not-a-version', '0.0.0'), 0);
    assert.equal(compareVersions('0.7.x', '0.7.0'), 0);
  });
});

describe('checkForUpdate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-update-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reports an available update and writes the throttle cache', async () => {
    const cacheFile = join(dir, 'a', 'update-check.json');
    const result = await checkForUpdate({
      currentVersion: '0.7.2', env: {}, fetchImpl: okFetch('0.8.0'),
      cacheFile, now: 1000,
    });
    assert.deepEqual(result, { latest: '0.8.0', updateAvailable: true });
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).latest, '0.8.0');
  });

  it('is quiet when current already IS latest', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.8.0', env: {}, fetchImpl: okFetch('0.8.0'),
      cacheFile: join(dir, 'b', 'update-check.json'), now: 1000,
    });
    assert.deepEqual(result, { latest: '0.8.0', updateAvailable: false });
  });

  it('uses the cache instead of the network within 24h', async () => {
    const cacheFile = join(dir, 'c', 'update-check.json');
    await checkForUpdate({
      currentVersion: '0.7.2', env: {}, fetchImpl: okFetch('0.8.0'),
      cacheFile, now: 1000,
    });
    let fetched = 0;
    const result = await checkForUpdate({
      currentVersion: '0.7.2', env: {},
      fetchImpl: async () => { fetched++; return { ok: true, json: async () => ({ version: '0.9.0' }) }; },
      cacheFile, now: 1000 + 60 * 60 * 1000,
    });
    assert.equal(fetched, 0, 'no registry request while the cache is fresh');
    assert.equal(result.latest, '0.8.0');
  });

  it('re-fetches once the cache is older than 24h', async () => {
    const cacheFile = join(dir, 'd', 'update-check.json');
    await checkForUpdate({
      currentVersion: '0.7.2', env: {}, fetchImpl: okFetch('0.8.0'),
      cacheFile, now: 1000,
    });
    const result = await checkForUpdate({
      currentVersion: '0.7.2', env: {}, fetchImpl: okFetch('0.9.0'),
      cacheFile, now: 1000 + 25 * 60 * 60 * 1000,
    });
    assert.deepEqual(result, { latest: '0.9.0', updateAvailable: true });
  });

  it('returns null under CI / NO_UPDATE_NOTIFIER without touching network or cache', async () => {
    let fetched = 0;
    const spy = async () => { fetched++; return { ok: true, json: async () => ({ version: '9.9.9' }) }; };
    const cacheFile = join(dir, 'optout', 'update-check.json');
    assert.equal(await checkForUpdate({
      currentVersion: '0.7.2', env: { CI: 'true' }, fetchImpl: spy, cacheFile,
    }), null);
    assert.equal(await checkForUpdate({
      currentVersion: '0.7.2', env: { NO_UPDATE_NOTIFIER: '1' }, fetchImpl: spy, cacheFile,
    }), null);
    assert.equal(fetched, 0);
    assert.equal(existsSync(cacheFile), false);
  });

  it('fails silent on network errors and non-200s', async () => {
    assert.equal(await checkForUpdate({
      currentVersion: '0.7.2', env: {},
      fetchImpl: async () => { throw new Error('offline'); },
      cacheFile: join(dir, 'e.json'),
    }), null);
    assert.equal(await checkForUpdate({
      currentVersion: '0.7.2', env: {},
      fetchImpl: async () => ({ ok: false }),
      cacheFile: join(dir, 'f.json'),
    }), null);
  });

  it('aborts a hung request via the timeout and stays silent', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.7.2', env: {},
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      cacheFile: join(dir, 'g.json'), timeoutMs: 20,
    });
    assert.equal(result, null);
  });

  it('returns null when fetch is unavailable (older Node)', async () => {
    // On Node <18 the parameter default resolves to globalThis.fetch ===
    // undefined; passing null here reaches that same "not a function" guard
    // without the default substituting the REAL fetch (undefined would).
    assert.equal(await checkForUpdate({
      currentVersion: '0.7.2', env: {}, fetchImpl: null,
      cacheFile: join(dir, 'h.json'),
    }), null);
  });
});

describe('formatUpdateNotice', () => {
  it('names both versions and the update paths', () => {
    const s = formatUpdateNotice('0.7.2', '0.8.0');
    assert.ok(s.includes('0.7.2'));
    assert.ok(s.includes('0.8.0'));
    assert.ok(s.includes('npm install -g cyborg-hunter'));
  });
});

describe('formatCollectedVersionNotice', () => {
  it('is null when all sessions match the CLI version or carry none', () => {
    assert.equal(formatCollectedVersionNotice(['0.7.2', null, '0.7.2'], '0.7.2'), null);
    assert.equal(formatCollectedVersionNotice([null, undefined], '0.7.2'), null);
    assert.equal(formatCollectedVersionNotice([], '0.7.2'), null);
  });

  it('lists each distinct mismatched version once, oldest first', () => {
    const s = formatCollectedVersionNotice(['0.6.0', '0.3.0', '0.3.0', '0.7.2'], '0.7.2');
    assert.ok(s.includes('0.3.0, 0.6.0'));
    assert.ok(s.includes('this CLI is 0.7.2'));
  });
});

describe('extractIntegrityData libraryVersion surfacing', () => {
  it('carries the payload top-level libraryVersion into the participant object', () => {
    const raw = {
      participantId: 'P1', libraryVersion: '0.6.0',
      trials: [{ integrity: { paste_events: 0 } }],
    };
    assert.equal(extractIntegrityData(raw, {}).libraryVersion, '0.6.0');
  });

  it('is null when the payload carries none (CSV-derived data)', () => {
    const raw = { participantId: 'P1', trials: [{ integrity: {} }] };
    assert.equal(extractIntegrityData(raw, {}).libraryVersion, null);
  });
});
