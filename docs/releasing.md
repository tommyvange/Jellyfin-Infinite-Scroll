# Publishing releases

This repository uses GitHub Releases for downloadable packages and a dedicated `manifest` branch for the Jellyfin catalog:

```text
https://raw.githubusercontent.com/tommyvange/Jellyfin-Infinite-Scroll/manifest/manifest.json
```

The generated catalog is separate from the source branch. It appears after the first successful release. GitHub Actions uses its built-in token; no repository secrets, separate hosting, or Pages setup are required. CI receives read-only repository permissions, while the publication job receives `contents: write`.

## Normal release procedure

1. Set the next four-part plugin version in `Directory.Build.props`, such as `1.2.0.0`. It must be greater than the last public release version.
2. Update `release/notes.md` with the changes included in that release. Keep the plugin GUID and name unchanged in `release/config.json` and `Plugin.cs`.
3. Commit the changes to `main`, push, and let **Build and test** pass.
4. Create and push the exact matching tag:

   ```sh
   git tag -a v1.2.0.0 -m "Release 1.2.0.0"
   git push origin v1.2.0.0
   ```

   For the first release from the current source, use `v1.1.0.0` instead.

The tag must point to a commit on `main`. Version mismatches and prerelease tags are rejected. The **Publish release** workflow runs the reusable build workflow again from the tagged source, so publication does not depend on another workflow's temporary artifacts.

## What Actions does

1. Validates the shared plugin version, tag, runtime GUID/name, and compatibility configuration.
2. Runs JavaScript/runtime/release-tooling tests, .NET transformation tests, and registration tests.
3. Downloads or restores pinned production fixtures for each supported Jellyfin version, transforms them, checks JavaScript syntax, and executes the native query and toolbar bridge. The plugin is also compiled against each supported server package version.
4. Selects the package compiled against `minimumJellyfinVersion` for the catalog. The higher-version builds remain CI artifacts useful for verification.
5. Creates a draft GitHub release, uploads the ZIP and SHA-256 sidecar, downloads and verifies them, and publishes the draft.
6. Builds a catalog entry from those published ZIP bytes, including `version`, `targetAbi`, `sourceUrl`, `timestamp`, `changelog`, and Jellyfin's required **MD5** checksum.
7. Merges the entry with existing history and advances `manifest` with a normal Git commit and push. The catalog never advertises a ZIP before release publication is confirmed.

`meta.json` inside the ZIP describes the installed plugin. The generated repository `manifest.json` lists available releases. They are different documents. ZIPs contain only the plugin DLL and `meta.json`; server assemblies are supplied by Jellyfin.

## Why the catalog has one package per plugin version

Jellyfin treats `targetAbi` as a minimum version. Its updater orders releases by plugin version and requires a greater plugin version for an automatic update. Multiple packages with the same plugin version but different ABIs therefore complicate selection and do not automatically switch artifacts after a server upgrade.

This plugin uses one build against the oldest supported ABI and verifies its source/web integration across all supported versions. If Jellyfin introduces a server API break, adjust the minimum ABI, framework, compatibility targets, and plugin version before releasing an updated build. Do not claim compatibility with untested future major versions.

## Retrying a failed publication

Rerun the failed Actions workflow, or use **Publish release → Run workflow** and enter the existing tag.

If the release is still a draft, the workflow can replace its incomplete draft assets and retry. If it is already public, the workflow downloads the existing assets and uses their checksum; it never overwrites public ZIPs with newly rebuilt bytes. A retry then completes or confirms the catalog update. Existing catalog entries are retained and attempts to change an already published version's contents are rejected. Releases are serialized with a queue so catalog updates do not compete.

Never move a published tag or overwrite a public ZIP. Make a new version for fixes. The stable workflow does not publish existing prereleases into the stable catalog.

## Adding a compatibility target

Update `release/config.json` with the supported Jellyfin NuGet package version and its four pinned production web filenames. The CI matrix and fixture download use that same configuration. Review the corresponding upstream source and verify a running server before claiming support. Fixture caches are keyed by the version and configuration and store only the four extracted JavaScript files, not the full portable archive.

## Existing manual installations

Earlier local packages set `autoUpdate: false` in installed `meta.json`. Jellyfin preserves that preference during catalog refresh. Adding the repository alone cannot enable it. Replace the old DLL and metadata with the new package while Jellyfin is stopped, retaining the separate plugin configuration file. New packages use `autoUpdate: true`; update execution remains controlled by Jellyfin's settings and update task.

## Relevant upstream behavior

- [Jellyfin plugin repositories](https://jellyfin.org/posts/plugin-updates/) describe the catalog format and independent hosting of catalogs and ZIPs.
- [Jellyfin 12.2 installation/update code](https://github.com/jellyfin/jellyfin/blob/v12.2/Emby.Server.Implementations/Updates/InstallationManager.cs) defines minimum-ABI selection, version updates, and MD5 validation.
- [GitHub token permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) document the built-in workflow token.
- [GitHub release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) describes draft-first publication and immutable releases.
