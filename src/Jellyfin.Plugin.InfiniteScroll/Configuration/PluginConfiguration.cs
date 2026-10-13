using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.InfiniteScroll.Configuration;

/// <summary>Server-wide settings for lazy loading in the hosted web client.</summary>
public sealed class PluginConfiguration : BasePluginConfiguration
{
    public const int DefaultBatchSize = 100;
    public const int MinimumBatchSize = 1;
    public const int MaximumBatchSize = 1000;
    public const string DefaultCompletionMessage = "All items loaded.";

    public bool Enabled { get; set; } = true;

    public int BatchSize { get; set; } = DefaultBatchSize;

    public string CompletionMessage { get; set; } = DefaultCompletionMessage;

    public int GetEffectiveBatchSize() => Math.Clamp(BatchSize, MinimumBatchSize, MaximumBatchSize);
}
