# Publishing releases

This repository uses GitHub Releases for downloadable packages and a dedicated `manifest` branch for the Jellyfin catalog:

```text
https://raw.githubusercontent.com/tommyvange/Jellyfin-Infinite-Scroll/manifest/manifest.json
```

The generated catalog is separate from the source branch and is updated after each successful release. GitHub Actions uses its built-in token; no repository secrets, separate hosting, or Pages setup are required. CI receives read-only repository permissions, while the publication job receives `contents: write`.

## Normal release procedure

1. Set the next four-part plugin version in `Directory.Build.props`, such as `1.2.3.0`. It must be greater than the last public release version.
2. Update `release/notes.md` with the changes included in that release. Keep the plugin GUID and name unchanged in `release/config.json` and `Plugin.cs`.
3. Commit the changes to `main`, push, and let **Build and test** pass.
4. Create and push the exact matching tag:

   ```sh
   git tag -a v1.2.3.0 -m "Release 1.2.3.0"
   git push origin v1.2.3.0
   ```

   The current source version is `1.2.3.0`; `v1.2.1.0` is already published and must remain unchanged.

The tag must point to a commit on `main`. Version mismatches and prerelease tags are rejected. The **Publish release** workflow runs the reusable build workflow again from the tagged source, so publication does not depend on another workflow's temporary artifacts.

## What Actions does

1. Validates the shared plugin version, tag, runtime GUID/name, and compatibility configuration.
2. Runs JavaScript/runtime/release-tooling tests, .NET transformation tests, and registration tests.
3. Resolves the latest published stable Jellyfin release from the official GitHub API, then selects its exact production web package and SHA-256 from the official Debian package index. Tests that release and the pinned minimum baseline, with at most two targets. Each target must supply all five integration chunks, pass transformation/syntax checks, and execute the native query, toolbar and category bridges. The latest server package is also compiled to detect API/framework changes.
4. Builds and uploads only the package compiled against `minimumJellyfinVersion` for the catalog. The baseline production web package is pinned by URL and SHA-256 in `release/config.json`; the latest descriptor is fixed once per workflow run. A failed latest-release discovery never substitutes an older version.
5. Creates a draft GitHub release, uploads the ZIP and SHA-256 sidecar, downloads and verifies them, and publishes the draft.
6. Builds a catalog entry from those published ZIP bytes, including `version`, `targetAbi`, `sourceUrl`, `timestamp`, `changelog`, and Jellyfin's required **MD5** checksum.
7. Merges the entry with existing history and advances `manifest` with a normal Git commit and push. The catalog never advertises a ZIP before release publication is confirmed.

`meta.json` inside the ZIP describes the installed plugin. The generated repository `manifest.json` lists available releases. They are different documents. ZIPs contain the plugin DLL, `meta.json`, and the image configured by `imagePath` in `release/config.json`; server assemblies are supplied by Jellyfin. The packaged metadata references the local image filename, while the catalog's `imageUrl` points to the source image at the release tag. This displays the artwork in both the installed plugin page and catalog, including manual installations.

## Why the catalog has one package per plugin version

Jellyfin treats `targetAbi` as a minimum version. Its updater orders releases by plugin version and requires a greater plugin version for an automatic update. Multiple packages with the same plugin version but different ABIs therefore complicate selection and do not automatically switch artifacts after a server upgrade.

This plugin uses one build against the oldest supported ABI and verifies its web integration at the baseline and latest stable release. Intermediate minor versions do not accumulate as permanent build targets. If Jellyfin introduces a server API break, adjust the minimum ABI, framework, pinned baseline web package, and plugin version before releasing an updated build. Future major releases enter the latest check automatically so incompatibilities become visible; a successful check is still not a substitute for testing a running server before claiming support.

## Retrying a failed publication

Rerun the failed Actions workflow, or use **Publish release → Run workflow** and enter the existing tag.

For an older tag created before a workflow/tooling change, rerun its original workflow run. A new manual dispatch uses the current workflow definition, whose scripts and configuration must exist in the selected tag.

If the release is still a draft, the workflow can replace its incomplete draft assets and retry. If it is already public, the workflow downloads the existing assets and uses their checksum; it never overwrites public ZIPs with newly rebuilt bytes. A retry then completes or confirms the catalog update. Existing catalog entries are retained and attempts to change an already published version's contents are rejected. Releases are serialized with a queue so catalog updates do not compete.

Never move a published tag or overwrite a public ZIP. Make a new version for fixes. The stable workflow does not publish existing prereleases into the stable catalog.

## Compatibility policy

There is no minor-version list to maintain. **Build and test** runs on pushes, pull requests, release tags through the reusable workflow, manual dispatch, and every Monday at 06:23 UTC. It selects `minimumJellyfinVersion` and the latest stable version from `compatibility.latestReleaseUrl`, deduplicating them when equal. Prereleases and drafts are rejected. If the official package index has not yet published the matching web package, the run fails clearly and can be rerun after publication completes.

The web-only Debian package is about 32 MB. Its final signed bytes are checked against the SHA-256 from the official APT `Packages` index; the pre-signing `.changes` checksum describes different bytes and is unsuitable here. The downloader discovers Modern query/toolbar, Legacy Movies/Shows, and generic category-list chunks from their content, so new webpack IDs and content hashes require no configuration update. It validates cached originals and removes old generated patches before the current source transforms them again. Cache keys include the exact package checksum and discovery code.

Only change `minimumJellyfinVersion` and `compatibility.baselineWebPackage` when deliberately raising the support floor. Pin the matching official web package URL, final SHA-256 and size, review its upstream source, and test a running server. `compatibility.webPackageIndex` selects the official Debian distribution index used for latest discovery; it may need updating when Jellyfin drops that distribution. Source-controlled baseline metadata keeps the install ABI and baseline inputs reproducible, while each workflow run records its resolved latest version and checksum in the job summary. Public release ZIPs remain immutable across retries.

## Existing manual installations

Earlier local packages set `autoUpdate: false` in installed `meta.json`. Jellyfin preserves that preference during catalog refresh. Adding the repository alone cannot enable it. Replace the old DLL and metadata with the new package while Jellyfin is stopped, retaining the separate plugin configuration file. New packages use `autoUpdate: true`; update execution remains controlled by Jellyfin's settings and update task.

## Relevant upstream behavior

- [Jellyfin plugin repositories](https://jellyfin.org/posts/plugin-updates/) describe the catalog format and independent hosting of catalogs and ZIPs.
- [Jellyfin 12.2 installation/update code](https://github.com/jellyfin/jellyfin/blob/v12.2/Emby.Server.Implementations/Updates/InstallationManager.cs) defines minimum-ABI selection, version updates, and MD5 validation.
- [GitHub token permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) document the built-in workflow token.
- [GitHub release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) describes draft-first publication and immutable releases.
