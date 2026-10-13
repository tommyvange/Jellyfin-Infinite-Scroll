Infinite Scroll for the server-hosted Jellyfin Web client, verified against Jellyfin 12.0, 12.1, and 12.2.

- Load library items as you scroll, in configurable batches of 1–1000 (default 100).
- Retain Jellyfin's native cards, filters, sorting, selection, and playback actions.
- Support Modern library views and Legacy Movies and Shows.
- Retry failed batches without discarding existing items or skipping their offset.
- Customize the completion message, or leave it blank to hide it.

Install File Transformation 3.x matching your Jellyfin server version before installing Infinite Scroll. Restart Jellyfin and reload the web client after installation.

Native clients and separately hosted web clients are outside this extension's scope. Random sorting retains native pagination because its ordering changes between requests.
