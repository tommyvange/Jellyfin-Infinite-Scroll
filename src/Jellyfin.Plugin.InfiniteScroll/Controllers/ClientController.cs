using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.InfiniteScroll.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.InfiniteScroll.Controllers;

/// <summary>Serves the embedded client and its non-sensitive runtime settings.</summary>
[ApiController]
[Route("InfiniteScroll")]
public sealed class ClientController : ControllerBase
{
    private static readonly Lazy<string> ClientSource = new(ReadClientSource);

    [AllowAnonymous]
    [HttpGet("Client.js")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public ContentResult GetClient()
    {
        var settings = Plugin.Instance?.Configuration;
        string bootstrap = JsonSerializer.Serialize(new
        {
            enabled = settings?.Enabled ?? false,
            batchSize = settings?.GetEffectiveBatchSize() ?? PluginConfiguration.DefaultBatchSize,
            completionMessage = settings?.CompletionMessage ?? PluginConfiguration.DefaultCompletionMessage
        });

        return Content(
            "window.JellyfinInfiniteScrollConfig = " + bootstrap + ";\n" + ClientSource.Value,
            "application/javascript",
            Encoding.UTF8);
    }

    private static string ReadClientSource()
    {
        using Stream stream = typeof(Plugin).Assembly.GetManifestResourceStream(
            "Jellyfin.Plugin.InfiniteScroll.Web.infinite-scroll.js")
            ?? throw new InvalidOperationException("The embedded Infinite Scroll client resource is missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
