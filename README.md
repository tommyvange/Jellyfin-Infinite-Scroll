# Jellyfin Infinite Scroll

[![Build and test](https://github.com/tommyvange/Jellyfin-Infinite-Scroll/actions/workflows/build.yml/badge.svg)](https://github.com/tommyvange/Jellyfin-Infinite-Scroll/actions/workflows/build.yml)

A Jellyfin server plugin that replaces paging with lazy loading in the **server-hosted Jellyfin Web client**. Scroll toward the bottom of a library and the next batch appears in the same list. The default batch size is **100**, configurable from **1 to 1000** in the plugin settings.

The completion message is configurable too. Its default is **All items loaded.**; enter your own plain text or leave the setting blank to hide it. Existing configurations keep the default when upgrading.

The implementation targets Jellyfin **12.0 and newer**. The four production transformations and native query bridge are verified against the shipped **12.0, 12.1, and 12.2** web assets. Later versions are handled by structural matching; if Jellyfin changes an integration point, that asset is left intact and may require a plugin update. Future major releases cannot be guaranteed before testing them.

## Supported views

- **Modern layout:** Movies, Shows, Episodes, Favorites, Collections, Playlists, Albums, Artists, Album Artists, Songs, Studios/Networks, Books, Authors, Photos, Photo Albums, Videos, Music Videos, Mixed Media, and Folders, using their native ItemsView queries.
- **Legacy layout:** Movies and Shows, including the Movies controller's Favorites mode and its card/list layouts.
- Jellyfin's native cards, item actions, selection, filters, alphabet picker, image loading, and sort order are retained. Modern paging arrows are removed and the toolbar shows the total item count. Legacy library paging is hidden while scrolling is active.
- Requests load one batch at a time, stop at the server's total, and retain existing items when an appended request fails. A Retry button repeats the failed offset. Filters and ordinary refreshes start a new result set.

Suggestions, genre rows, Live TV, and other views that do not use the supported paged library query keep their normal behavior. **Random sort retains native paging** because Jellyfin generates a new random order for every request; offset paging cannot guarantee a complete, stable random list. This plugin does not virtualize the DOM: visited items remain mounted until the library is reset.

Native Android TV, Swiftfin, and other clients that render their own UI are outside this extension's scope. Separately hosted web clients do not pass through this server's File Transformation middleware.

## Install

1. Install the matching **File Transformation 3.x** build for your Jellyfin version. Add [IAmParadox27's plugin repository](https://www.iamparadox.dev/jellyfin/plugins/manifest.json) in **Dashboard → Plugins → Repositories**, then install **File Transformation** from the catalog. This is an explicit prerequisite; Jellyfin does not automatically install it from dependency metadata.
2. Add **Infinite Scroll** as a repository with this URL:

   ```text
   https://raw.githubusercontent.com/tommyvange/Jellyfin-Infinite-Scroll/manifest/manifest.json
   ```

3. Install **Infinite Scroll** from the catalog, restart Jellyfin, and hard-refresh the web client. The server log should include `Infinite Scroll registered its web transformations with File Transformation.`
4. Open **Dashboard → Plugins → Infinite Scroll**, choose the batch size and **All items loaded message**, and save. Reload open Jellyfin tabs after changing the settings. The settings apply to all users of the server-hosted web client.

The catalog URL becomes available after the first tagged release. [GitHub Releases](https://github.com/tommyvange/Jellyfin-Infinite-Scroll/releases) also provides ZIPs for manual installation: stop Jellyfin and extract the DLL and `meta.json` directly into `plugins/Infinite Scroll_<version>/`. For the official Docker image, the plugin directory is normally `/config/plugins/`.

The catalog distributes one package built against the minimum supported Jellyfin ABI, **12.0**; that package is intended for all tested Jellyfin 12 versions. CI additionally compiles and verifies the web integration against 12.0, 12.1, and 12.2. File Transformation itself still needs its matching server-version build.

**Upgrading an early manual installation:** the original local ZIPs set `autoUpdate` to false. Merely adding the catalog does not change that installed preference. Stop Jellyfin and replace the old DLL and `meta.json` with the new release package to use normal catalog updates; retain your separate plugin configuration file. New release packages set `autoUpdate` to true, and Jellyfin's own update settings and scheduled task control when updates run.

You can turn the extension off in its settings and reload the web client to restore native paging. To remove it, uninstall through the dashboard or stop Jellyfin and remove only its plugin directory.

If scrolling does not activate, check that both plugins are loaded, that File Transformation matches the server version, and that you are using the server's `/web/` client. Clear its cached assets after installation. The plugin discovers supported files in the installed web directory at startup; restart Jellyfin after replacing web assets. File Transformation selects one filename-pattern pipeline. This plugin registers only the recognized files by exact path so it does not consume unrelated plugins' JavaScript pipelines. A different transformation of the same target file still needs compatible integration.

## Build and package

Requirements: **.NET 10 SDK**, **Node.js 20+**, and the `zip` utility. There are no npm dependencies. Server-provided Jellyfin assemblies are not bundled in the ZIP.

```sh
npm test
dotnet run --project tests/Transformations
dotnet run --project tests/RegistrationScanner
node scripts/package.mjs 12.2.0
```

Pass `12.0.0` or `12.1.0` to package for those versions. Set `DOTNET=/absolute/path/to/dotnet` if the SDK is not on your PATH. Packages and SHA-256 checksums are written to `artifacts/`. The plugin DLL embeds its settings page and client script.

The plugin release version is defined in `Directory.Build.props`. The DLL version, ZIP name, plugin manifest, and client-script cache key derive from that value.

To repeat the verification against official production bundles for a specific supported version:

```sh
bash scripts/fetch-web-fixtures.sh 12.2.0
node scripts/verify-web.mjs .research/fixtures/12.2.0
dotnet run --project tests/Transformations -- .research/fixtures/12.2.0/*.chunk.js
node scripts/verify-web.mjs --syntax .research/fixtures/12.2.0/*.patched.js
node scripts/verify-native-bridge.mjs .research/fixtures/12.2.0
```

The fixture downloader retains four pinned production web chunks from the official portable archive under `.research/fixtures/<version>/`. Complete caches skip downloading. CI verifies the production assets and compiles the plugin for every version listed in `release/config.json`.

The runtime tests cover loading, offsets, deduplication, failures/retries, cancellation, stale requests, navigation, native paging fallbacks, completion messages, and Legacy scroll/focus behavior. The transformation tests verify untouched unsupported assets, idempotency, renamed minifier bindings, and syntax of actual patched assets. Registration tests verify exact-file discovery, unrelated chunk exclusion, nested paths, and stable transformation IDs. Release-tooling tests verify catalog checksums and history, stable identity, package contents, draft publication, and safe retries.

These checks do not replace testing on a running Jellyfin server with an actual media library. Before distributing a release, verify Movies and Shows in both layouts, filters, sorting, returning from item details, playback/selection, a configured reverse-proxy base path, and a failed network request.

## GitHub releases and catalog

Push a version tag matching `Directory.Build.props`, such as `v1.1.0.0`, to publish a stable release. Actions reruns all checks, publishes the tested minimum-ABI ZIP and SHA-256 sidecar, and then updates the generated catalog on the `manifest` branch. The catalog contains Jellyfin's required MD5 checksum of the exact published ZIP, with a fixed release URL and prior versions retained. No personal access token, custom server, or GitHub Pages configuration is required.

See [the release guide](docs/releasing.md) for versioning, retries, and maintaining compatibility targets.

## Implementation and research

[Jellyfin 12](https://jellyfin.org/posts/jellyfin-release-12.0/) made Modern the default layout and moved server plugins to .NET 10. Supporting only the older `.itemsContainer` controllers would therefore miss the default interface.

The plugin uses [File Transformation 3](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation/releases) to edit served assets without modifying installed web files. A hosted service registers reflection callbacks after all plugin instances have been constructed. The registration follows the dependency's [documented reflection bridge](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation#referencing-this-as-a-library), avoiding cross-plugin assembly-load-context dependencies.

The index transformation loads a same-origin client script before Jellyfin's bundles. The client URL is relative to `/web/`, preserving a server base path. The script contains only public plugin settings; requests for library data still use Jellyfin's authenticated native API client and user permissions.

For Modern libraries, a guarded transformation wraps [useGetItemsViewByType](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/hooks/useFetchItems.ts). Each native request receives a cloned view-settings object with a batch offset and limit; the saved settings and user page-size preference stay intact. IntersectionObserver triggers native React Query refetches, and merged DTOs feed the existing [ItemsView](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/modern/features/libraries/components/ItemsView.tsx). A separate guarded [toolbar](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/modern/features/libraries/components/LibraryToolbar.tsx) transformation disables its pagination controls and range text while that query is active.

The [Legacy Movies](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/legacy/controllers/movies/movies.js) and [Legacy Shows](https://github.com/jellyfin/jellyfin-web/blob/v12.2/src/apps/legacy/controllers/shows/tvshows.js) transformations wrap their own fetch/render callbacks. Appended batches preserve the scroll position and focus. Startup discovery scans webpack chunks and registers exact relative paths only for recognized assets. Content fingerprints require every supported structure before applying edits; unsupported bundles are returned unchanged.

Sources and packaged versions were checked on **13 October 2026**, including the [official Web releases](https://github.com/jellyfin/jellyfin-web/releases) and [portable production archives](https://repo.jellyfin.org/files/server/portable/stable/v12.2/any/).
