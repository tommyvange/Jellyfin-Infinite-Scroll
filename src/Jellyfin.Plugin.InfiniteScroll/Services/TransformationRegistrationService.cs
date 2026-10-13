using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using Jellyfin.Plugin.InfiniteScroll.Transformations;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.InfiniteScroll.Services;

/// <summary>Integrates with File Transformation without sharing its assembly load context.</summary>
public sealed class TransformationRegistrationService : IHostedService
{
    public const string FileTransformationPluginId = "5e87cc92-571a-4d8d-8d98-d2d4147f9f90";

    private readonly ILogger<TransformationRegistrationService> _logger;
    private readonly IApplicationPaths _applicationPaths;
    private readonly List<Guid> _registeredIds = new();
    private MethodInfo? _removeTransformation;

    public TransformationRegistrationService(
        ILogger<TransformationRegistrationService> logger,
        IApplicationPaths applicationPaths)
    {
        _logger = logger;
        _applicationPaths = applicationPaths;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (_registeredIds.Count > 0) return Task.CompletedTask;
        Assembly? dependency = AssemblyLoadContext.All
            .SelectMany(context => context.Assemblies)
            .FirstOrDefault(assembly => assembly.GetName().Name == "Jellyfin.Plugin.FileTransformation");

        if (dependency is null || dependency.GetName().Version?.Major < 3)
        {
            _logger.LogWarning(
                "Infinite Scroll needs File Transformation 3 or newer for this Jellyfin version. Install it from https://www.iamparadox.dev/jellyfin/plugins/manifest.json and restart Jellyfin.");
            return Task.CompletedTask;
        }

        try
        {
            Type? bridge = dependency.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            MethodInfo? register = bridge?.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);

            if (register is null || register.GetParameters().Length != 1)
            {
                _logger.LogWarning("Infinite Scroll could not find the File Transformation registration API.");
                return Task.CompletedTask;
            }

            _removeTransformation = bridge?.GetMethod("RemoveTransformation", BindingFlags.Public | BindingFlags.Static);
            RegisterAndTrack(register, Plugin.PluginGuid, "index.html", nameof(WebTransformations.TransformIndex));

            // File Transformation selects one matching pattern pipeline. Registering a
            // catch-all regex would suppress other plugins even when our patch is a no-op.
            IReadOnlyList<WebAssetRegistration> assets = WebAssetScanner.Discover(
                _applicationPaths.WebPath,
                Plugin.PluginGuid,
                (path, exception) => _logger.LogWarning(exception, "Infinite Scroll could not inspect web asset {Path}.", path));
            foreach (WebAssetRegistration asset in assets)
            {
                RegisterAndTrack(register, asset.Id, asset.RelativePath, nameof(WebTransformations.TransformJavaScript));
            }

            _logger.LogInformation(
                "Infinite Scroll registered its web transformations with File Transformation ({ChunkCount} compatible JavaScript chunks).",
                assets.Count);
            if (assets.Count == 0)
            {
                _logger.LogWarning(
                    "Infinite Scroll found no compatible library chunks under {WebPath}. Check the server-hosted Jellyfin web installation and this plugin's supported web versions.",
                    _applicationPaths.WebPath);
            }
        }
        catch (Exception exception)
        {
            // An optional web enhancement must never prevent the media server from starting.
            RemoveRegistrations();
            _logger.LogError(Unwrap(exception), "Infinite Scroll could not register its File Transformation callbacks.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        RemoveRegistrations();
        return Task.CompletedTask;
    }

    private void RemoveRegistrations()
    {
        if (_removeTransformation is not null)
        {
            foreach (Guid id in _registeredIds)
            {
                try
                {
                    _removeTransformation.Invoke(null, new object[] { id });
                }
                catch (Exception exception)
                {
                    _logger.LogDebug(Unwrap(exception), "Infinite Scroll could not remove callback {Id}.", id);
                }
            }
        }
        _registeredIds.Clear();
    }

    private void RegisterAndTrack(MethodInfo register, Guid transformationId, string fileNamePattern, string callbackMethod)
    {
        string payloadJson = JsonSerializer.Serialize(new
        {
            id = transformationId,
            fileNamePattern,
            callbackAssembly = typeof(WebTransformations).Assembly.FullName,
            callbackClass = typeof(WebTransformations).FullName,
            callbackMethod
        });

        // Construct the payload in the dependency's Newtonsoft.Json context. This also works
        // when Jellyfin loads plugins into different AssemblyLoadContext instances.
        Type payloadType = register.GetParameters()[0].ParameterType;
        MethodInfo? parse = payloadType.GetMethod(
            "Parse",
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: new[] { typeof(string) },
            modifiers: null);
        object payload = parse?.Invoke(null, new object[] { payloadJson })
            ?? throw new InvalidOperationException("File Transformation's payload type has no supported Parse method.");

        register.Invoke(null, new[] { payload });
        _registeredIds.Add(transformationId);
    }

    private static Exception Unwrap(Exception exception) =>
        exception is TargetInvocationException { InnerException: not null } invocation
            ? invocation.InnerException!
            : exception;
}
