# Jellyfin Infinite Scroll

[![Build and test](https://github.com/tommyvange/Jellyfin-Infinite-Scroll/actions/workflows/build.yml/badge.svg)](https://github.com/tommyvange/Jellyfin-Infinite-Scroll/actions/workflows/build.yml)

A Jellyfin server plugin that replaces paging with lazy loading in the **server-hosted Jellyfin Web client**. Scroll toward the bottom of a library and the next batch appears in the same list. The default batch size is **100**, configurable from **1 to 1000** in the plugin settings.

The status messages are configurable too. **Loading more items…** appears while a batch is loading, and **All items loaded.** appears at the end. Enter your own plain text or leave either setting blank to hide its text. Existing configurations keep these defaults when upgrading.

The implementation targets Jellyfin **12.0 and newer**. CI verifies the minimum supported version and the **latest stable Jellyfin release**, resolved from official release metadata on every run. The current production checks pass for **12.0 and 12.4** (31 October 2026). If Jellyfin changes an integration point, its asset is left intact and CI reports the incompatibility. Future major releases are checked automatically, but support depends on their server API, framework and web integration remaining compatible.

## Supported views

- **Modern layout:** Movies, Shows, Episodes, Favorites, Collections, Playlists, Albums, Artists, Album Artists, Songs, Studios/Networks, Books, Authors, Photos, Photo Albums, Videos, Music Videos, Mixed Media, and Folders, using their native ItemsView queries.
- **Legacy layout:** Movies and Shows, including the Movies controller's Favorites mode and its card/list layouts.
- **Category results in both layouts:** Movies → Categories → Comedy and other genre results, plus the shared list page's music genre, studio, and person results. These pages use the configured batch size and status messages too.
- The category toolbar shows the server's total for the current filters, such as **731**, while the page range and pagination arrows are hidden. The count stays the same as more items load and updates when the filtered total changes.
- Jellyfin's native cards, item actions, selection, filters, alphabet picker, image loading, and sort order are retained. Modern paging arrows are removed and the toolbar shows the total item count. Legacy library paging is hidden while scrolling is active.
- Requests load one batch at a time, stop at the server's total, and retain existing items when an appended request fails. A Retry button repeats the failed offset. Filters and ordinary refreshes start a new result set.

Horizontal suggestion and genre preview rows, Live TV, and other views that do not use the supported paged library queries keep their normal behavior. **Random sort retains native paging** because Jellyfin generates a new random order for every request; offset paging cannot guarantee a complete, stable random list. This plugin does not virtualize the DOM: visited items remain mounted until the library is reset.

Native Android TV, Swiftfin, and other clients that render their own UI are outside this extension's scope. Separately hosted web clients do not pass through this server's File Transformation middleware.

## Install

1. Install the matching **File Transformation 3.x** build for your Jellyfin version. Add [IAmParadox27's plugin repository](https://www.iamparadox.dev/jellyfin/plugins/manifest.json) in **Dashboard → Plugins → Repositories**, then install **File Transformation** from the catalog. This is an explicit prerequisite; Jellyfin does not automatically install it from dependency metadata.
2. Add **Infinite Scroll** as a repository with this URL:

   ```text
   https://raw.githubusercontent.com/tommyvange/Jellyfin-Infinite-Scroll/manifest/manifest.json
   ```

3. Install **Infinite Scroll** from the catalog, restart Jellyfin, and hard-refresh the web client. The server log should include `Infinite Scroll registered its web transformations with File Transformation.`
4. Open **Dashboard → Plugins → Infinite Scroll**, choose the batch size, **Loading more items message**, and **All items loaded message**, and save. Reload open Jellyfin tabs after changing the settings. The settings apply to all users of the server-hosted web client.

The [catalog](https://raw.githubusercontent.com/tommyvange/Jellyfin-Infinite-Scroll/manifest/manifest.json) and [GitHub Releases](https://github.com/tommyvange/Jellyfin-Infinite-Scroll/releases) also provide ZIPs for manual installation: stop Jellyfin and extract all ZIP contents (the DLL, `meta.json`, and plugin image) directly into `plugins/Infinite Scroll_<version>/`. For the official Docker image, the plugin directory is normally `/config/plugins/`.

The catalog distributes one package built against the minimum supported Jellyfin ABI, **12.0**. CI verifies production web assets at that baseline and at the latest stable release, and compiles against the latest server package to detect API changes. It does not rebuild a growing list of past minor versions. File Transformation itself still needs its matching server-version build.

**Upgrading an early manual installation:** the original local ZIPs set `autoUpdate` to false. Merely adding the catalog does not change that installed preference. Stop Jellyfin and replace the old DLL and `meta.json` with the new release package to use normal catalog updates; retain your separate plugin configuration file. New release packages set `autoUpdate` to true, and Jellyfin's own update settings and scheduled task control when updates run.

You can turn the extension off in its settings and reload the web client to restore native paging. To remove it, uninstall through the dashboard or stop Jellyfin and remove only its plugin directory.

If scrolling does not activate, check that both plugins are loaded, that File Transformation matches the server version, and that you are using the server's `/web/` client. Clear its cached assets after installation. The plugin discovers supported files in the installed web directory at startup; restart Jellyfin after replacing web assets. File Transformation selects one filename-pattern pipeline. This plugin registers only the recognized files by exact path so it does not consume unrelated plugins' JavaScript pipelines. A different transformation of the same target file still needs compatible integration.

## Build and package

Requirements: **.NET 10 SDK**, **Node.js 20+**, and the `zip` utility. There are no npm dependencies. Server-provided Jellyfin assemblies are not bundled in the ZIP.

```sh
npm test
dotnet run --project tests/Transformations
dotnet run --project tests/RegistrationScanner
node scripts/package.mjs
```

Packaging defaults to the minimum supported ABI from `release/config.json`; pass an explicit Jellyfin NuGet package version only when testing another build target. Set `DOTNET=/absolute/path/to/dotnet` if the SDK is not on your PATH. Packages and SHA-256 checksums are written to `artifacts/`. The plugin DLL embeds its settings page and client script.

The plugin release version is defined in `Directory.Build.props`. The DLL version, ZIP name, plugin manifest, and client-script cache key derive from that value.

To repeat the verification against the latest official production web client (also requires the `ar` and `tar` utilities):

```sh
FIXTURE_DIR=.research/fixtures/latest
bash scripts/fetch-web-fixtures.sh latest "$FIXTURE_DIR"
node scripts/verify-web.mjs "$FIXTURE_DIR"
dotnet run --project tests/Transformations -- "$FIXTURE_DIR"/*.chunk.js
node scripts/verify-web.mjs --syntax "$FIXTURE_DIR"/*.patched.js
node scripts/verify-native-bridge.mjs "$FIXTURE_DIR"
node scripts/verify-category-bridge.mjs "$FIXTURE_DIR"
```

Use an exact version such as `12.0.0` instead of `latest` to repeat a particular check. Without a directory argument, fixtures go under `.research/fixtures/<resolved-version>/`. The downloader uses the official **web-only Debian package** (about 32 MB, instead of the roughly 300 MB portable server archive), verifies its SHA-256, and discovers the five integration chunks by their code. Chunk IDs and filename hashes are not hardcoded. Only those selected assets and a provenance/checksum record are retained; complete, validated caches skip the package download.

GitHub Actions checks at most two versions: the pinned baseline and the latest published stable release, deduplicated if they are the same. The latest version and package checksum are resolved once per run and passed unchanged to the jobs. Metadata/network failures and missing production assets fail the check instead of falling back to an older version. A weekly Monday check also detects upstream changes when this repository has no commits. Releases run the same checks and publish only the minimum-ABI package.

The runtime tests cover loading, offsets, deduplication, failures/retries, cancellation, stale requests, navigation, native paging fallbacks, completion messages, and Legacy scroll/focus behavior. The transformation tests verify untouched unsupported assets, idempotency, renamed minifier bindings, and syntax of actual patched assets. Registration tests verify exact-file discovery, unrelated chunk exclusion, nested paths, and stable transformation IDs. Release-tooling tests verify catalog checksums and history, stable identity, package contents, draft publication, and safe retries.

These checks do not replace testing on a running Jellyfin server with an actual media library. Before distributing a release, verify Movies and Shows in both layouts, opening a genre/category and scrolling its results, filters, sorting, returning from item details, playback/selection, a configured reverse-proxy base path, and a failed network request.

## GitHub releases and catalog

Push a version tag matching `Directory.Build.props`, such as `v1.2.1.0`, to publish a stable release. Actions reruns all checks, publishes the tested minimum-ABI ZIP and SHA-256 sidecar, and then updates the generated catalog on the `manifest` branch. The catalog contains Jellyfin's required MD5 checksum of the exact published ZIP, with a fixed release URL and prior versions retained. No personal access token, custom server, or GitHub Pages configuration is required.

See [the release guide](docs/releasing.md) for versioning, retries, and the baseline/latest compatibility policy.

## Implementation and research

[Jellyfin 12](https://jellyfin.org/posts/jellyfin-release-12.0/) made Modern the default layout and moved server plugins to .NET 10. Supporting only the older `.itemsContainer` controllers would therefore miss the default interface.

The plugin uses [File Transformation 3](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation/releases) to edit served assets without modifying installed web files. A hosted service registers reflection callbacks after all plugin instances have been constructed. The registration follows the dependency's [documented reflection bridge](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation#referencing-this-as-a-library), avoiding cross-plugin assembly-load-context dependencies.

The index transformation loads a same-origin client script before Jellyfin's bundles. The client URL is relative to `/web/`, preserving a server base path. The script contains only public plugin settings; requests for library data still use Jellyfin's authenticated native API client and user permissions.

For Modern libraries, a guarded transformation wraps [useGetItemsViewByType](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/hooks/useFetchItems.ts). Each native request receives a cloned view-settings object with a batch offset and limit; the saved settings and user page-size preference stay intact. IntersectionObserver triggers native React Query refetches, and merged DTOs feed the existing [ItemsView](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/modern/features/libraries/components/ItemsView.tsx). A separate guarded [toolbar](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/modern/features/libraries/components/LibraryToolbar.tsx) transformation disables its pagination controls and range text while that query is active.

The [Legacy Movies](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/legacy/controllers/movies/movies.js) and [Legacy Shows](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/legacy/controllers/shows/tvshows.js) transformations wrap their own fetch/render callbacks. Appended batches preserve the scroll position and focus. Startup discovery scans webpack chunks and registers exact relative paths only for recognized assets. Content fingerprints require every supported structure before applying edits; unsupported bundles are returned unchanged.

Category links from either layout open the [shared Legacy list controller](https://github.com/jellyfin/jellyfin-web/blob/v12.4/src/apps/legacy/controllers/list.js). Its transformation wraps only the displayed list's fetch callback, passing adapted offsets and limits into Jellyfin's native item query. The controller continues to apply the authenticated server client, genre and parent-library constraints, filters, sort, and alphabet picker. The session identity includes those view settings so a change resets the accumulated results. Play All, Queue, and Shuffle use separate native requests that the transformation leaves intact.

Sources and production packages were checked on **31 October 2026**, including the [official Web releases](https://github.com/jellyfin/jellyfin-web/releases) and [official Debian package index](https://repo.jellyfin.org/debian/dists/trixie/main/binary-amd64/Packages).
