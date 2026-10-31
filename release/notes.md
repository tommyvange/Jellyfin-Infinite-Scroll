Infinite Scroll for the server-hosted Jellyfin Web client.

- Show the category's total item count at the top of its results, such as 731, while hiding the native page range and pagination arrows.
- Use the server's total for the current category and filters, independently of how many items have loaded so far.
- Restore the count when returning from item details and restore native pagination when infinite scrolling is disabled or random sorting is selected.

Install File Transformation 3.x matching your Jellyfin server version before installing Infinite Scroll. Restart Jellyfin and reload the web client after installation.

Native clients and separately hosted web clients are outside this extension's scope. Random sorting retains native pagination because its ordering changes between requests.
