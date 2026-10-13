namespace Jellyfin.Plugin.InfiniteScroll.Transformations;

/// <summary>Data accepted by File Transformation's reflection callback.</summary>
public sealed class TransformationRequest
{
    public string Contents { get; set; } = string.Empty;
}
