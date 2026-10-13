import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference) return Math.sign(difference);
    }
    return 0;
}

export function readReleaseInfo(root = projectRoot) {
    const version = readFileSync(resolve(root, 'Directory.Build.props'), 'utf8')
        .match(/<Version>(\d+\.\d+\.\d+\.\d+)<\/Version>/)?.[1];
    if (!version) throw new Error('Directory.Build.props must define a four-part plugin Version.');
    const config = JSON.parse(readFileSync(resolve(root, 'release/config.json'), 'utf8'));
    const pluginSource = readFileSync(resolve(root, 'src/Jellyfin.Plugin.InfiniteScroll/Plugin.cs'), 'utf8');
    const pluginId = pluginSource.match(/const string PluginId\s*=\s*"([^"]+)"/)?.[1];
    const pluginName = pluginSource.match(/override string Name\s*=>\s*"([^"]+)"/)?.[1];
    if (pluginId !== config.guid || pluginName !== config.name) {
        throw new Error('Release GUID/name must match Plugin.cs and stay stable for existing installations.');
    }
    if (!/^\d+\.\d+\.\d+$/.test(config.minimumJellyfinVersion) ||
        !Array.isArray(config.testedJellyfinVersions) || !config.testedJellyfinVersions.length ||
        !config.testedJellyfinVersions.includes(config.minimumJellyfinVersion)) {
        throw new Error('The minimum Jellyfin version must be included in the tested version list.');
    }
    for (const target of config.testedJellyfinVersions) {
        if (!/^\d+\.\d+\.\d+$/.test(target) || compareVersions(target, config.minimumJellyfinVersion) < 0 ||
            !config.webFixtures[target]?.files?.length) {
            throw new Error(`Missing or invalid compatibility target: ${target}`);
        }
    }
    return { version, tag: `v${version}`, config };
}

export function packageFileName(info, jellyfinVersion = info.config.minimumJellyfinVersion) {
    if (!/^\d+\.\d+\.\d+$/.test(jellyfinVersion) || compareVersions(jellyfinVersion, info.config.minimumJellyfinVersion) < 0) {
        throw new Error(`Jellyfin version must be ${info.config.minimumJellyfinVersion} or newer.`);
    }
    return `${info.config.assemblyName}_${info.version}_jellyfin-${jellyfinVersion}.zip`;
}

export function validateTag(tag, info) {
    if (tag !== info.tag) throw new Error(`Release tag must be ${info.tag} to match Directory.Build.props; got ${tag}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const info = readReleaseInfo();
    if (process.env.EXPECTED_TAG) validateTag(process.env.EXPECTED_TAG, info);
    if (process.argv.includes('--github-output')) {
        console.log(`version=${info.version}`);
        console.log(`matrix=${JSON.stringify({ jellyfin: info.config.testedJellyfinVersions })}`);
        console.log(`minimum-jellyfin=${info.config.minimumJellyfinVersion}`);
    } else {
        console.log(JSON.stringify({ ...info, packageFile: packageFileName(info) }, null, 2));
    }
}
