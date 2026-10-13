using Jellyfin.Plugin.InfiniteScroll.Transformations;

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

string index = "<!DOCTYPE html><html><head><script src=\"runtime.js\"></script></head><body></body></html>";
string injected = WebAssetPatcher.PatchIndex(index);
Assert(injected.IndexOf("InfiniteScroll/Client.js", StringComparison.Ordinal) < injected.IndexOf("runtime.js", StringComparison.Ordinal), "Client must initialize before native bundles.");
Assert(injected.Contains("Client.js?v=" + typeof(WebAssetPatcher).Assembly.GetName().Version, StringComparison.Ordinal), "Client cache key must follow the compiled release version.");
Assert(WebAssetPatcher.PatchIndex(injected) == injected, "Index injection must be idempotent.");
Assert(WebAssetPatcher.PatchIndex("<html>no head</html>") == "<html>no head</html>", "Unsupported HTML must remain intact.");
Assert(WebAssetPatcher.PatchJavaScript("const untouched = 'ViewByType';") == "const untouched = 'ViewByType';", "Unsupported JS must remain intact.");
string balanced = "{value:'}',nested:{a:1},/* } */other:\"\\\"}\"}";
Assert(WebAssetPatcher.FindClosing(balanced, 0) == balanced.Length - 1, "Balanced object scanner must ignore quoted/comment braces.");

// A small synthetic hook varies minifier names and exercises structural guards.
string offsets = string.Join(";", Enumerable.Repeat("api.getItems({startIndex:settings.StartIndex,fields:(0,helpers.fields)(),other:(0,helpers.limit)()})", 5));
string options = "{queryKey:[\"User\",user,\"Items\",parent,\"ViewByType\",view,{itemType:types,libraryViewSettings:config}],queryFn:function(ctx){var signal=ctx.signal;return function(api,view,parent,types,settings,options){" + offsets + ";return api.result}(api,view,parent,types,config,{signal:signal})},refetchOnWindowFocus:!1,enabled:true}";
string synthetic = "function hook(){return(0,query.use)(" + options + ")}";
// Only the limit getter is repeated in production; the fixture's fields getter
// is repeated too, so ambiguity must cause an all-or-nothing fallback.
Assert(WebAssetPatcher.PatchJavaScript(synthetic) == synthetic, "Ambiguous imports must not produce a partial patch.");
synthetic = synthetic.Replace("fields:(0,helpers.fields)(),", string.Empty, StringComparison.Ordinal);
string syntheticPatched = WebAssetPatcher.PatchJavaScript(synthetic);
Assert(syntheticPatched != synthetic, "Renamed compatible hook must be recognized.");
Assert(syntheticPatched.Contains("JellyfinInfiniteScroll.settings(config)", StringComparison.Ordinal), "Settings clone must be supplied before the async fetch.");
Assert(syntheticPatched.Contains("settings.__jellyfinInfiniteScrollBatchSize||(\u00280,helpers.limit)()).limit", StringComparison.Ordinal), "Request override must retain the original native limit.");
Assert(WebAssetPatcher.PatchJavaScript(syntheticPatched) == syntheticPatched, "JavaScript patches must be idempotent.");
Assert(WebAssetPatcher.PatchJavaScript(synthetic.Replace("refetchOnWindowFocus:", "changedProperty:", StringComparison.Ordinal)) == synthetic.Replace("refetchOnWindowFocus:", "changedProperty:", StringComparison.Ordinal), "Changed upstream hook must remain intact.");
Console.WriteLine("PASS: index injection, scanner, structural guards, renamed bindings, limit overrides, and idempotency.");

// Optional real fixtures can be supplied locally, without redistributing the
// complete upstream bundles. Patched output is used for Node syntax validation.
foreach (string path in args)
{
    string original = File.ReadAllText(path);
    string transformed = WebAssetPatcher.PatchJavaScript(original);
    Assert(transformed != original, "Expected a recognized production asset: " + path);
    Assert(WebAssetPatcher.PatchJavaScript(transformed) == transformed, "Production patch must be idempotent: " + path);
    string output = path + ".patched.js";
    File.WriteAllText(output, transformed);
    Console.WriteLine("PASS: " + Path.GetFileName(path) + " → " + output);
}
