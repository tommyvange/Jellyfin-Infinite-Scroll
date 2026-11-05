Infinite Scroll for the server-hosted Jellyfin Web client.

- Keep category results at their current scroll position when another batch loads, including genres such as Movies → Categories → Comedy.
- Preserve the focused card or link across Jellyfin's category rendering, including delayed focus scrolling in the web TV layout.
- Capture the position immediately before rendering so scrolling while a request is pending remains respected, including failed requests and retries.

Install File Transformation 3.x matching your Jellyfin server version before installing Infinite Scroll. Restart Jellyfin and reload the web client after installation.

Native clients and separately hosted web clients are outside this extension's scope. Random sorting retains native pagination because its ordering changes between requests.
