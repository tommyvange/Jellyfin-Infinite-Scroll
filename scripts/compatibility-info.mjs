import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions, readReleaseInfo } from './release-info.mjs';

export function normalizeJellyfinVersion(value) {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value ?? '');
    if (!match) throw new Error(`Expected a stable Jellyfin release version, got ${value}.`);
    return match.slice(1).map(component => Number(component ?? 0)).join('.');
}

/** Bounded requests with retries; never substitute an older release on failure. */
export async function fetchOfficial(url, { fetchImpl = fetch, maxBytes = 5_000_000, token = process.env.GH_TOKEN } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'repo.jellyfin.org'].includes(parsed.hostname)) {
        throw new Error(`Expected an official HTTPS metadata/package URL: ${url}`);
    }
    let failure;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const headers = { 'User-Agent': 'Jellyfin-Infinite-Scroll-compatibility' };
            if (parsed.hostname === 'api.github.com') {
                headers.Accept = 'application/vnd.github+json';
                if (token) headers.Authorization = `Bearer ${token}`;
            }
            const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(120_000) });
            if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}: ${url}`);
            if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error(`Upstream response is too large: ${url}`);
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > maxBytes) throw new Error(`Upstream response is too large: ${url}`);
                chunks.push(chunk);
            }
            return Buffer.concat(chunks);
        } catch (error) {
            failure = error;
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
    throw failure;
}

export function latestStableVersion(release, minimum) {
    if (!release || release.draft !== false || release.prerelease !== false) {
        throw new Error('Official latest release is not a published stable release.');
    }
    const version = normalizeJellyfinVersion(release.tag_name);
    if (compareVersions(version, minimum) < 0) throw new Error(`Latest stable Jellyfin ${version} is below the supported minimum ${minimum}.`);
    return version;
}

export function findWebPackage(index, version) {
    const candidates = [];
    for (const block of index.split(/\r?\n\s*\r?\n/)) {
        const fields = Object.fromEntries(block.split(/\r?\n/).filter(line => /^[A-Za-z][\w-]*: /.test(line))
            .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
        if (fields.Package !== 'jellyfin-web' || fields.Architecture !== 'all') continue;
        const match = /^(\d+\.\d+(?:\.\d+)?)\+deb(\d+)$/.exec(fields.Version ?? '');
        if (!match || normalizeJellyfinVersion(match[1]) !== version) continue;
        if (!/^pool\/[\w/+.-]+\.deb$/.test(fields.Filename ?? '') || fields.Filename.includes('..') ||
            !/^[a-f\d]{64}$/.test(fields.SHA256 ?? '') || !/^\d+$/.test(fields.Size ?? '') ||
            Number(fields.Size) <= 0 || Number(fields.Size) > 100_000_000) {
            throw new Error(`Invalid official production web package metadata for ${version}.`);
        }
        candidates.push({ version, url: new URL(fields.Filename, 'https://repo.jellyfin.org/debian/').href,
            sha256: fields.SHA256, size: Number(fields.Size), debian: Number(match[2]) });
    }
    candidates.sort((a, b) => b.debian - a.debian);
    if (!candidates.length) throw new Error(`No official production web package for latest stable Jellyfin ${version}; refusing a stale compatibility check.`);
    const { debian: _debian, ...selected } = candidates[0];
    return selected;
}

export async function compatibilityPlan(info, { fetchImpl, token } = {}) {
    const policy = info.config.compatibility;
    const release = JSON.parse((await fetchOfficial(policy.latestReleaseUrl, { fetchImpl, token })).toString('utf8'));
    const latest = latestStableVersion(release, info.config.minimumJellyfinVersion);
    const baseline = { jellyfin: info.config.minimumJellyfinVersion, role: 'minimum ABI', webPackage: policy.baselineWebPackage, publishPackage: true };
    const targets = [baseline];
    if (latest !== baseline.jellyfin) {
        const index = (await fetchOfficial(policy.webPackageIndex, { fetchImpl, token })).toString('utf8');
        targets.push({ jellyfin: latest, role: 'latest stable', webPackage: findWebPackage(index, latest), publishPackage: false });
    }
    return { latest, releaseUrl: release.html_url, matrix: { include: targets } };
}

async function main() {
    const info = readReleaseInfo();
    const plan = await compatibilityPlan(info);
    if (process.argv.includes('--github-output')) {
        console.log(`latest-jellyfin=${plan.latest}`);
        console.log(`matrix=${JSON.stringify(plan.matrix)}`);
    } else console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(`Jellyfin compatibility discovery failed: ${error.message}`); process.exitCode = 1; });
}
