using Jellyfin.Plugin.InfiniteScroll.Services;

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

Guid pluginId = Guid.Parse("b8407ec8-9945-4fd4-baa7-47f349ed945a");
string webRoot = Path.Combine(Path.GetTempPath(), "jellyfin-infinite-scroll-scanner-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(webRoot);
try
{
    string requests = string.Join(";", Enumerable.Repeat("api.getItems({startIndex:settings.StartIndex,other:(0,helpers.limit)()})", 5));
    string options = "{queryKey:[\"User\",user,\"Items\",parent,\"ViewByType\",view,{itemType:types,libraryViewSettings:config}],queryFn:function(ctx){var signal=ctx.signal;return function(api,view,parent,types,settings,options){" + requests + ";return api.result}(api,view,parent,types,config,{signal:signal})},refetchOnWindowFocus:!1,enabled:true}";
    string compatible = "function hook(){return(0,query.use)(" + options + ")}";
    File.WriteAllText(Path.Combine(webRoot, "100.abcd.chunk.js"), compatible);
    File.WriteAllText(Path.Combine(webRoot, "200.abcd.chunk.js"), "window.unrelated={loadSections:function(){}};");
    Directory.CreateDirectory(Path.Combine(webRoot, "nested"));
    File.WriteAllText(Path.Combine(webRoot, "nested", "300.abcd.chunk.js"), compatible);
    File.WriteAllText(Path.Combine(webRoot, "400.abcd.js"), compatible);

    IReadOnlyList<WebAssetRegistration> first = WebAssetScanner.Discover(webRoot, pluginId);
    Assert(first.Count == 2, "Only compatible chunk files should be registered.");
    Assert(first[0].RelativePath == "100.abcd.chunk.js", "Register the exact top-level filename.");
    Assert(first[1].RelativePath == "nested/300.abcd.chunk.js", "Nested filenames must retain web-relative slash paths.");
    Assert(first.Select(asset => asset.Id).Distinct().Count() == 2, "Each file must have its own identity.");
    IReadOnlyList<WebAssetRegistration> repeated = WebAssetScanner.Discover(webRoot, pluginId);
    Assert(first.SequenceEqual(repeated), "Transformation identities must remain stable across startups.");
    Assert(WebAssetScanner.Discover(webRoot, Guid.NewGuid())[0].Id != first[0].Id, "Different plugin namespaces must produce different identities.");
    Assert(WebAssetScanner.Discover(Path.Combine(webRoot, "missing"), pluginId).Count == 0, "A missing web root must not cause a startup error.");

    IReadOnlyList<WebAssetRegistration> beforeRewrite = WebAssetScanner.Discover(webRoot, pluginId);
    File.WriteAllText(Path.Combine(webRoot, "100.abcd.chunk.js"), "window.nowUnsupported=true;");
    IReadOnlyList<WebAssetRegistration> afterRewrite = WebAssetScanner.Discover(webRoot, pluginId);
    Assert(beforeRewrite.Count == 2 && afterRewrite.Count == 1, "Only currently compatible assets should be registered.");

    string largePath = Path.Combine(webRoot, "500.abcd.chunk.js");
    using (var large = File.Create(largePath)) large.SetLength(WebAssetScanner.MaximumAssetBytes + 1);
    var failures = new List<string>();
    IReadOnlyList<WebAssetRegistration> bounded = WebAssetScanner.Discover(webRoot, pluginId, (path, _) => failures.Add(path));
    Assert(bounded.Count == 1 && failures.SequenceEqual(new[] { largePath }), "Oversized files must be skipped and reported.");
    Console.WriteLine("PASS: compatible discovery, unrelated chunk exclusion, nested paths, stable identities, missing roots, and bounded reads.");
}
finally
{
    Directory.Delete(webRoot, recursive: true);
}
