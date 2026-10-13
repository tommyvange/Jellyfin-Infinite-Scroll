import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readReleaseInfo, packageFileName } from './release-info.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const info = readReleaseInfo();
const { version, config } = info;
const jellyfinVersion = process.argv[2] || config.minimumJellyfinVersion;
const packageName = packageFileName(info, jellyfinVersion).slice(0, -4);
const dotnet = process.env.DOTNET || 'dotnet';
function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
run(dotnet, ['build', 'src/Jellyfin.Plugin.InfiniteScroll', '-c', 'Release', `-p:JellyfinVersion=${jellyfinVersion}`]);
const output = join(root, 'artifacts', packageName);
mkdirSync(output, { recursive: true });
const dllName = `${config.assemblyName}.dll`;
copyFileSync(join(root, 'src/Jellyfin.Plugin.InfiniteScroll/bin/Release/net10.0', dllName), join(output, dllName));
const manifest = {
    category: config.category, changelog: readFileSync(join(root, 'release/notes.md'), 'utf8').trim(),
    description: config.description, guid: config.guid, name: config.name,
    overview: config.overview, owner: config.owner,
    targetAbi: `${jellyfinVersion}.0`, version, status: 'Active', autoUpdate: true,
    assemblies: [dllName]
};
writeFileSync(join(output, 'meta.json'), JSON.stringify(manifest, null, 2) + '\n');
const zipPath = join(root, 'artifacts', packageName + '.zip');
// zip updates an existing archive; remove it first so reruns cannot retain stale files.
if (existsSync(zipPath)) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(zipPath);
}
run('zip', ['-q', '-X', zipPath, dllName, 'meta.json'], output);
const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(zipPath + '.sha256', `${sha256}  ${packageName}.zip\n`);
console.log(`Packaged ${zipPath}`);
console.log(`SHA-256 ${sha256}`);
