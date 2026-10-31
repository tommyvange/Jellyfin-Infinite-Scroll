Infinite Scroll for the server-hosted Jellyfin Web client.

- Add infinite scrolling to category/genre result pages opened from both Modern and Legacy layouts, including Movies → Categories → Comedy.
- Preserve the native genre and parent-library filters, sorting, alphabet picker, cards, and playback actions. Play All, Queue, and Shuffle keep their original requests.
- Use the configured batch size and completion message on category result pages too, with retry support for failed batches.
- Check the minimum supported Jellyfin version and the latest stable release automatically, instead of maintaining a growing list of every minor version.

Install File Transformation 3.x matching your Jellyfin server version before installing Infinite Scroll. Restart Jellyfin and reload the web client after installation.

Native clients and separately hosted web clients are outside this extension's scope. Random sorting retains native pagination because its ordering changes between requests.
