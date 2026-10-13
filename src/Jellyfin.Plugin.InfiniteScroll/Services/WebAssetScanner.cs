using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.InfiniteScroll.Transformations;

namespace Jellyfin.Plugin.InfiniteScroll.Services;

/// <summary>A compatible local web asset and its stable transformation identity.</summary>
public sealed record WebAssetRegistration(Guid Id, string RelativePath);

/// <summary>Discovers only the local chunks this plugin can actually modify.</summary>
public static class WebAssetScanner
{
    public const long MaximumAssetBytes = 30L * 1024 * 1024;

    public static IReadOnlyList<WebAssetRegistration> Discover(
        string webRoot,
        Guid pluginId,
        Action<string, Exception>? reportError = null)
    {
        var assets = new List<WebAssetRegistration>();
        if (string.IsNullOrWhiteSpace(webRoot) || !Directory.Exists(webRoot)) return assets;

        try
        {
            var enumeration = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = false,
                AttributesToSkip = FileAttributes.ReparsePoint
            };
            foreach (string path in Directory.EnumerateFiles(webRoot, "*.chunk.js", enumeration))
            {
                try
                {
                    if (new FileInfo(path).Length > MaximumAssetBytes)
                    {
                        reportError?.Invoke(path, new IOException("The web asset exceeds the 30 MiB scanning limit."));
                        continue;
                    }

                    string source = File.ReadAllText(path);
                    if (!source.Contains("\"ViewByType\"", StringComparison.Ordinal) &&
                        !source.Contains("\"ListPaging\"", StringComparison.Ordinal) &&
                        !source.Contains("IncludeItemTypes", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (WebAssetPatcher.PatchJavaScript(source) == source) continue;

                    string relativePath = Path.GetRelativePath(webRoot, path).Replace(Path.DirectorySeparatorChar, '/');
                    byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(pluginId + ":" + relativePath));
                    assets.Add(new WebAssetRegistration(new Guid(hash.AsSpan(0, 16)), relativePath));
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or RegexMatchTimeoutException)
                {
                    reportError?.Invoke(path, exception);
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            reportError?.Invoke(webRoot, exception);
        }

        return assets.OrderBy(asset => asset.RelativePath, StringComparer.Ordinal).ToArray();
    }
}
