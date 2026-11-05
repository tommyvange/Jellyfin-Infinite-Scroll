Infinite Scroll for the server-hosted Jellyfin Web client.

- Append only new cards on category pages, including genres such as Movies → Categories → Comedy. Existing posters and blurhash canvases stay mounted instead of reloading with each batch.
- Initialize Jellyfin's native image lazy loading only for newly added cards, preserving existing focus and scroll position through loads, failures, and retries.
- Use the same MUI Chip markup and public theme classes as the Movies and Shows count, with fallback styles that CSS themes can override.

Install File Transformation 3.x matching your Jellyfin server version before installing Infinite Scroll. Restart Jellyfin and reload the web client after installation.

Native clients and separately hosted web clients are outside this extension's scope. Random sorting retains native pagination because its ordering changes between requests.
