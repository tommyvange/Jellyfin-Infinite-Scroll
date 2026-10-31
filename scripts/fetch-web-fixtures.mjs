import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchOfficial, findWebPackage, latestStableVersion, normalizeJellyfinVersion } from './compatibility-info.mjs';
import { projectRoot, readReleaseInfo } from './release-info.mjs';
import { assertWebAssetCoverage, identifyWebAsset } from './verify-web.mjs';

const schema = 1;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureName = name => /^[\w.-]+\.chunk\.js$/.test(name);

export function validateWebPackage(descriptor) {
    assert.equal(normalizeJellyfinVersion(descriptor.version), descriptor.version, 'Web package version must have three components');
    assert.ok(Number(descriptor.version.split('.')[0]) >= 12, 'Web package must target Jellyfin 12 or newer');
    const url = new URL(descriptor.url);
    assert.ok(url.protocol === 'https:' && url.hostname === 'repo.jellyfin.org' && url.pathname.startsWith('/debian/pool/') && url.pathname.endsWith('.deb'), 'Expected official Jellyfin production web package');
    assert.match(descriptor.sha256, /^[a-f\d]{64}$/);
    assert.ok(Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && descriptor.size <= 100_000_000, 'Invalid web package size');
}

export async function selectWebAssets(webRoot) {
    const assets = [];
    for (const name of (await readdir(webRoot)).filter(fixtureName).sort()) {
        const source = await readFile(join(webRoot, name));
        const asset = identifyWebAsset(source.toString('utf8'));
        if (asset) assets.push({ kind: asset.kind, name, sha256: sha256(source), source });
    }
    assertWebAssetCoverage(assets);
    return assets;
}

async function cachedAssets(directory, descriptor) {
    try {
        const metadata = JSON.parse(await readFile(join(directory, 'fixtures.json'), 'utf8'));
        if (metadata.schema !== schema || !metadata.webPackage ||
            ['version', 'url', 'sha256', 'size'].some(key => metadata.webPackage[key] !== descriptor[key]) || !Array.isArray(metadata.files)) return false;
        const assets = [];
        for (const file of metadata.files) {
            if (!fixtureName(file.name)) return false;
            const source = await readFile(join(directory, file.name));
            if (sha256(source) !== file.sha256) return false;
            const asset = identifyWebAsset(source.toString('utf8'));
            if (!asset || asset.kind !== file.kind) return false;
            assets.push(asset);
        }
        assertWebAssetCoverage(assets);
        // Unknown originals indicate a mixed or incomplete cache; rediscover it.
        const originals = (await readdir(directory)).filter(fixtureName).sort();
        return JSON.stringify(originals) === JSON.stringify(metadata.files.map(file => file.name).sort());
    } catch { return false; }
}

async function removePatchedOutput(directory) {
    for (const name of await readdir(directory)) {
        if (name.endsWith('.patched.js')) await rm(join(directory, name));
    }
}

export async function fetchWebFixtures(descriptor, directory, { download = fetchOfficial } = {}) {
    validateWebPackage(descriptor);
    await mkdir(directory, { recursive: true });
    if (await cachedAssets(directory, descriptor)) {
        await removePatchedOutput(directory);
        return { cached: true, directory, version: descriptor.version };
    }
    const work = await mkdtemp(join(tmpdir(), 'jellyfin-web-fixtures-'));
    try {
        const bytes = await download(descriptor.url, { maxBytes: descriptor.size });
        assert.equal(bytes.length, descriptor.size, 'Production web package size differs from official metadata');
        assert.equal(sha256(bytes), descriptor.sha256, 'Production web package SHA-256 differs from official metadata');
        const archive = join(work, 'jellyfin-web.deb');
        await writeFile(archive, bytes);
        const members = execFileSync('ar', ['t', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
        const payloads = members.filter(name => /^data\.tar\.(xz|gz|zst)$/.test(name));
        assert.equal(payloads.length, 1, 'Expected one Debian web package payload');
        const payload = join(work, payloads[0]);
        await writeFile(payload, execFileSync('ar', ['p', archive, payloads[0]], { maxBuffer: 100_000_000 }));
        const chunkMembers = execFileSync('tar', ['-tf', payload], { encoding: 'utf8', maxBuffer: 5_000_000 })
            .trim().split(/\r?\n/).filter(name => /^(?:\.\/)?usr\/share\/jellyfin\/web\/[\w.-]+\.chunk\.js$/.test(name));
        assert.ok(chunkMembers.length, 'No production JavaScript chunks in official web package');
        execFileSync('tar', ['-xf', payload, '-C', work, ...chunkMembers]);
        const assets = await selectWebAssets(join(work, 'usr/share/jellyfin/web'));
        // Change the managed fixture directory only after download, checksum and
        // complete integration coverage succeed. Retain just the selected chunks.
        for (const name of await readdir(directory)) {
            if (fixtureName(name) || name.endsWith('.patched.js')) await rm(join(directory, name));
        }
        for (const asset of assets) await writeFile(join(directory, asset.name), asset.source);
        await writeFile(join(directory, 'fixtures.json'), JSON.stringify({ schema, webPackage: descriptor,
            files: assets.map(({ source: _source, ...file }) => file) }, null, 2) + '\n');
        return { cached: false, directory, version: descriptor.version, files: assets.map(asset => asset.name) };
    } finally { await rm(work, { recursive: true, force: true }); }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length > 2) throw new Error('Usage: bash scripts/fetch-web-fixtures.sh [version|latest] [fixture directory]');
    const info = readReleaseInfo();
    const policy = info.config.compatibility;
    let version;
    let descriptor;
    if (process.env.JELLYFIN_WEB_PACKAGE) {
        descriptor = JSON.parse(process.env.JELLYFIN_WEB_PACKAGE);
        version = normalizeJellyfinVersion(args[0] ?? descriptor.version);
        assert.equal(descriptor.version, version, 'CI web package descriptor does not match the selected version');
    } else {
        version = !args[0] || args[0] === 'latest' ? latestStableVersion(JSON.parse((await fetchOfficial(policy.latestReleaseUrl)).toString('utf8')), info.config.minimumJellyfinVersion)
            : normalizeJellyfinVersion(args[0]);
        descriptor = version === info.config.minimumJellyfinVersion ? policy.baselineWebPackage
            : findWebPackage((await fetchOfficial(policy.webPackageIndex)).toString('utf8'), version);
    }
    const directory = resolve(args[1] ?? join(projectRoot, '.research/fixtures', version));
    const result = await fetchWebFixtures(descriptor, directory);
    console.log(`${result.cached ? 'Validated cached' : 'Downloaded and selected'} Jellyfin ${version} production web fixtures in ${directory}`);
    if (result.files) console.log(result.files.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(`Jellyfin Web fixture download failed: ${error.message}`); process.exitCode = 1; });
}
