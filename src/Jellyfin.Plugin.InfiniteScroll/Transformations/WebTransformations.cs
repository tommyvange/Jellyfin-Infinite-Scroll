namespace Jellyfin.Plugin.InfiniteScroll.Transformations;

/// <summary>File Transformation reflection callbacks. Never alter unsupported assets.</summary>
public static class WebTransformations
{
    public static string TransformIndex(TransformationRequest request) =>
        Plugin.Instance?.Configuration.Enabled == true ? WebAssetPatcher.PatchIndex(request.Contents) : request.Contents;

    public static string TransformJavaScript(TransformationRequest request) =>
        Plugin.Instance?.Configuration.Enabled == true ? WebAssetPatcher.PatchJavaScript(request.Contents) : request.Contents;
}
