using Jellyfin.Plugin.InfiniteScroll.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.InfiniteScroll;

/// <summary>The Infinite Scroll server plugin and configuration page.</summary>
public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public const string PluginId = "b8407ec8-9945-4fd4-baa7-47f349ed945a";
    public static readonly Guid PluginGuid = Guid.Parse(PluginId);

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Infinite Scroll";

    public override Guid Id => PluginGuid;

    public override string Description => "Load library items in configurable batches as you scroll, replacing pagination in supported Jellyfin web views.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "InfiniteScroll",
            EmbeddedResourcePath = "Jellyfin.Plugin.InfiniteScroll.Web.config.html"
        };
    }

    public override void UpdateConfiguration(BasePluginConfiguration configuration)
    {
        if (configuration is PluginConfiguration settings)
        {
            settings.BatchSize = settings.GetEffectiveBatchSize();
        }

        base.UpdateConfiguration(configuration);
    }
}
