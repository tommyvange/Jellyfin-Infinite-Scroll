'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helpers = Promise.all([
    import('../scripts/compatibility-info.mjs'), import('../scripts/fetch-web-fixtures.mjs'), import('../scripts/verify-web.mjs')
]).then(modules => Object.assign({}, ...modules));

const baseline = { version: '12.0.0', url: 'https://repo.jellyfin.org/debian/pool/main/j/jellyfin/web.deb', sha256: '0'.repeat(64), size: 123 };
const info = { config: { minimumJellyfinVersion: baseline.version, compatibility: {
    latestReleaseUrl: 'https://api.github.com/repos/jellyfin/jellyfin/releases/latest',
    webPackageIndex: 'https://repo.jellyfin.org/debian/dists/trixie/main/binary-amd64/Packages', baselineWebPackage: baseline
} } };
const release = tag => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/jellyfin/jellyfin/releases/tag/${tag}` });
const packageBlock = (version, extra = {}) => Object.entries({
    Package: 'jellyfin-web', Version: `${version}+deb13`, Architecture: 'all',
    Filename: `pool/main/j/jellyfin/jellyfin-web_${version}+deb13_all.deb`, Size: '1234', SHA256: 'a'.repeat(64), ...extra
}).map(([key, value]) => `${key}: ${value}`).join('\n');

test('stable release resolution normalizes two/three components and refuses draft, preview, malformed or older releases', async () => {
    const { normalizeJellyfinVersion, latestStableVersion } = await helpers;
    assert.equal(normalizeJellyfinVersion('v12.4'), '12.4.0');
    assert.equal(normalizeJellyfinVersion('12.10.1'), '12.10.1');
    assert.equal(latestStableVersion(release('v13.0'), '12.0.0'), '13.0.0');
    for (const invalid of ['v12.4-rc1', '12', '12.4.0.1', 'latest']) assert.throws(() => normalizeJellyfinVersion(invalid), /stable Jellyfin release/);
    for (const invalid of [{ ...release('v12.4'), draft: true }, { ...release('v13.0'), prerelease: true }, {}, null]) {
        assert.throws(() => latestStableVersion(invalid, '12.0.0'), /published stable release/);
    }
    assert.throws(() => latestStableVersion(release('v11.10.7'), '12.0.0'), /below the supported minimum/);
});

test('production package selection matches exact release, validates provenance and never falls back to an older package', async () => {
    const { findWebPackage } = await helpers;
    const index = [packageBlock('12.2'), packageBlock('12.4'), packageBlock('12.10')].join('\n\n');
    const selected = findWebPackage(index, '12.4.0');
    assert.equal(selected.version, '12.4.0');
    assert.match(selected.url, /jellyfin-web_12\.4\+deb13_all\.deb$/);
    assert.equal(selected.sha256, 'a'.repeat(64));
    assert.equal(selected.size, 1234);
    assert.throws(() => findWebPackage(index, '12.5.0'), /refusing a stale compatibility check/);
    for (const fields of [{ Filename: '../outside.deb' }, { SHA256: 'wrong' }, { Size: '0' }, { Size: '100000001' }]) {
        assert.throws(() => findWebPackage(packageBlock('12.4', fields), '12.4.0'), /Invalid official production/);
    }
});

test('CI selects only baseline and latest, includes future majors, and deduplicates when baseline is latest', async () => {
    const { compatibilityPlan } = await helpers;
    for (const latest of ['12.4', '12.10', '13.0']) {
        const calls = [];
        const plan = await compatibilityPlan(info, { fetchImpl: async url => {
            calls.push(url);
            return new Response(url.includes('api.github.com') ? JSON.stringify(release(`v${latest}`)) : packageBlock(latest));
        } });
        assert.equal(plan.matrix.include.length, 2);
        assert.deepEqual(plan.matrix.include.map(target => target.jellyfin), ['12.0.0', `${latest}.0`]);
        assert.deepEqual(plan.matrix.include.map(target => target.publishPackage), [true, false]);
        assert.deepEqual(plan.matrix.include[0].webPackage, baseline);
        assert.equal(plan.matrix.include[1].webPackage.version, `${latest}.0`);
        assert.equal(calls.length, 2);
    }
    const plan = await compatibilityPlan(info, { fetchImpl: async url => {
        assert.match(url, /api.github.com/);
        return new Response(JSON.stringify(release('v12.0')));
    } });
    assert.equal(plan.matrix.include.length, 1);
    assert.equal(plan.matrix.include[0].publishPackage, true);
});

test('latest discovery failures retry and fail instead of accepting the baseline as latest', async () => {
    const { compatibilityPlan } = await helpers;
    let calls = 0;
    await assert.rejects(compatibilityPlan(info, { fetchImpl: async () => { calls++; return new Response('unavailable', { status: 503 }); } }), /HTTP 503/);
    assert.equal(calls, 4);
});

test('requests authenticate only GitHub API calls and reject nonofficial URLs before fetching', async () => {
    const { fetchOfficial } = await helpers;
    const calls = [];
    const fetchImpl = async (url, options) => { calls.push({ url, options }); return new Response('ok'); };
    await fetchOfficial(info.config.compatibility.latestReleaseUrl, { fetchImpl, token: 'test-token' });
    await fetchOfficial(info.config.compatibility.webPackageIndex, { fetchImpl, token: 'test-token' });
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(calls[1].options.headers.Authorization, undefined);
    await assert.rejects(fetchOfficial('https://example.com/package.deb', { fetchImpl }), /official HTTPS/);
    assert.equal(calls.length, 2);
});

test('package checksum failure preserves existing fixtures and rejects bytes before extraction', async t => {
    const { fetchWebFixtures } = await helpers;
    const directory = mkdtempSync(path.join(tmpdir(), 'infinite-scroll-fixtures-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const original = path.join(directory, 'previous.chunk.js');
    writeFileSync(original, 'prior fixture');
    const bytes = Buffer.from('not an official package');
    const descriptor = { ...baseline, size: bytes.length, sha256: createHash('sha256').update('other bytes').digest('hex') };
    await assert.rejects(fetchWebFixtures(descriptor, directory, { download: async () => bytes }), /SHA-256 differs/);
    assert.equal(readFileSync(original, 'utf8'), 'prior fixture');
});

test('web coverage rejects missing and duplicate integration kinds instead of silently weakening latest checks', async () => {
    const { assertWebAssetCoverage, requiredWebAssetKinds } = await helpers;
    const complete = requiredWebAssetKinds.map(kind => ({ kind }));
    assert.doesNotThrow(() => assertWebAssetCoverage(complete));
    assert.throws(() => assertWebAssetCoverage(complete.slice(0, -1)), /legacy-list/);
    assert.throws(() => assertWebAssetCoverage([...complete, complete[0]]), /modern-library/);
});
