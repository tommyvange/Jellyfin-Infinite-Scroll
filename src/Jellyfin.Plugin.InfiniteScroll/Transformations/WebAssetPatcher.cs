using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.InfiniteScroll.Transformations;

/// <summary>
/// Applies guarded edits to the production Jellyfin Web query hook. Minifier names
/// are captured from the code rather than depending on a particular chunk hash.
/// </summary>
public static partial class WebAssetPatcher
{
    public const string Marker = "/* jellyfin-infinite-scroll:1 */";
    private const string Identifier = @"[A-Za-z_$][\w$]*";
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(2);

    public static string PatchIndex(string source)
    {
        if (source.Contains("data-jellyfin-infinite-scroll", StringComparison.Ordinal)) return source;
        Match head = Regex.Match(source, @"<head(?:\s[^>]*)?>", RegexOptions.IgnoreCase, RegexTimeout);
        if (!head.Success) return source;
        // Jellyfin serves index.html under /web/. The relative URL also preserves
        // a configured reverse-proxy base path, such as /jellyfin/web/.
        string version = typeof(WebAssetPatcher).Assembly.GetName().Version!.ToString();
        return source.Insert(head.Index + head.Length,
            "<script data-jellyfin-infinite-scroll src=\"../InfiniteScroll/Client.js?v=" + version + "\"></script>");
    }

    public static string PatchJavaScript(string source)
    {
        if (source.Contains(Marker, StringComparison.Ordinal)) return source;
        if (TryPatchModern(source, out string modern)) return Marker + modern;
        if (TryPatchLegacyList(source, out string list)) return Marker + list;
        if (TryPatchLegacy(source, out string legacy)) return Marker + legacy;
        if (TryPatchToolbar(source, out string toolbar)) return Marker + toolbar;
        return source;
    }

    public static bool TryPatchModern(string source, out string patched)
    {
        patched = source;
        int anchor = source.IndexOf("\"ViewByType\"", StringComparison.Ordinal);
        if (anchor < 0) return false;

        // This uniquely identifies useGetItemsViewByType, rather than the many
        // other useQuery calls used by home rows, search, dialogs, and playback.
        string callPattern = @"return\s*(?<call>\(0," + Identifier + @"\." + Identifier + @"\)|" + Identifier + @")\(\s*(?<options>\{queryKey:\[\""User\"",)";
        Match[] calls = Regex.Matches(source[..anchor], callPattern, RegexOptions.None, RegexTimeout).Cast<Match>().ToArray();
        if (calls.Length == 0) return false;
        Match call = calls[^1];
        int optionsStart = call.Groups["options"].Index;
        int optionsEnd = FindClosing(source, optionsStart);
        if (optionsEnd <= anchor || optionsEnd + 1 >= source.Length || source[optionsEnd + 1] != ')') return false;
        string options = source[optionsStart..(optionsEnd + 1)];
        Match settings = Regex.Match(options,
            @"\""ViewByType\""," + Identifier + @",\{itemType:" + Identifier + @",libraryViewSettings:(?<settings>" + Identifier + @")\}",
            RegexOptions.None, RegexTimeout);
        if (!settings.Success || !options.Contains("refetchOnWindowFocus:", StringComparison.Ordinal)) return false;

        // Current production builds inline fetchGetItemsViewByType into queryFn.
        // Capture the settings argument at its call site, outside the async body.
        string invocationPattern = @"\}\((?<prefix>" + Identifier + @"," + Identifier + @"," + Identifier + @"," + Identifier + @",)(?<settings>" + Identifier + @")(?<suffix>,\{signal:" + Identifier + @"\})\)";
        Match[] invocations = Regex.Matches(options, invocationPattern, RegexOptions.None, RegexTimeout)
            .Cast<Match>().Where(match => match.Groups["settings"].Value == settings.Groups["settings"].Value).ToArray();
        if (invocations.Length != 1) return false;

        Match[] offsets = Regex.Matches(options, @"startIndex:(?<settings>" + Identifier + @")\.StartIndex", RegexOptions.None, RegexTimeout)
            .Cast<Match>().ToArray();
        if (offsets.Length < 5 || offsets.Select(match => match.Groups["settings"].Value).Distinct().Count() != 1) return false;

        // getLimitQuery is the repeated zero-argument imported getter in this hook.
        // Its original result is retained for disabled/unsupported/random views.
        string[] limitGetters = Regex.Matches(options, @"\(0," + Identifier + @"\." + Identifier + @"\)\(\)", RegexOptions.None, RegexTimeout)
            .Cast<Match>().GroupBy(match => match.Value).Where(group => group.Count() >= 5).Select(group => group.Key).ToArray();
        if (limitGetters.Length != 1) return false;

        Match invocation = invocations[0];
        string settingsName = invocation.Groups["settings"].Value;
        string invocationReplacement = "}(" + invocation.Groups["prefix"].Value +
            "(window.JellyfinInfiniteScroll?window.JellyfinInfiniteScroll.settings(" + settingsName + "):" + settingsName + ")" +
            invocation.Groups["suffix"].Value + ")";
        options = options.Remove(invocation.Index, invocation.Length).Insert(invocation.Index, invocationReplacement);
        options = Regex.Replace(options, @"startIndex:(?<settings>" + Identifier + @")\.StartIndex", match =>
            match.Value + ",limit:" + match.Groups["settings"].Value + ".__jellyfinInfiniteScrollBatchSize||(" + limitGetters[0] + ").limit",
            RegexOptions.None, RegexTimeout);

        string nativeHook = call.Groups["call"].Value;
        string replacement = "return((window.JellyfinInfiniteScroll&&window.JellyfinInfiniteScroll.useQuery)||function(h,o){return h(o)})(" + nativeHook + "," + options + ")";
        int end = optionsEnd + 2;
        patched = source.Remove(call.Index, end - call.Index).Insert(call.Index, replacement);
        return true;
    }

    public static bool TryPatchLegacy(string source, out string patched)
    {
        patched = source;
        bool movies = source.Contains("IncludeItemTypes:\"Movie\"", StringComparison.Ordinal) && source.Contains(".fetchData=", StringComparison.Ordinal);
        bool series = source.Contains("IncludeItemTypes:\"Series\"", StringComparison.Ordinal) && source.Contains("context:\"tvshows\"", StringComparison.Ordinal);
        if (!movies && !series) return false;
        Match exported = Regex.Match(source, @"default:function\(\)\{return (?<name>" + Identifier + @")\}", RegexOptions.None, RegexTimeout);
        if (!exported.Success) return false;
        Match controller = Regex.Match(source, @"function " + Regex.Escape(exported.Groups["name"].Value) + @"\(" + Identifier + @"," + Identifier + @",(?<host>" + Identifier + @")(?:," + Identifier + @")?\)(?<body>\{)", RegexOptions.None, RegexTimeout);
        if (!controller.Success) return false;
        int start = controller.Groups["body"].Index;
        int end = FindClosing(source, start);
        if (end < start) return false;
        string body = source[start..(end + 1)];
        string host = controller.Groups["host"].Value;
        Match query = Regex.Match(body, @"getQueryPagingHtml\(\{startIndex:(?<query>" + Identifier + @")\.StartIndex", RegexOptions.None, RegexTimeout);
        if (!query.Success) return false;
        string queryName = query.Groups["query"].Value;
        string request = "ApiClient.getItems(ApiClient.getCurrentUserId()," + queryName + ")";
        if (Count(body, request) != 1 || Count(body, "window.scrollTo(0,0)") != 1) return false;

        string refresh;
        if (movies)
        {
            Match container = Regex.Match(body, @"(?<container>" + Identifier + @")\.fetchData=" + Identifier + @"," + Identifier + @"\.getItemsHtml=", RegexOptions.None, RegexTimeout);
            if (!container.Success) return false;
            refresh = container.Groups["container"].Value + ".refreshItems()";
        }
        else
        {
            Match render = Regex.Match(body, @"this\.renderTab=function\(\)\{(?:var " + Identifier + @";)?(?<refresh>" + Identifier + @")\(" + Regex.Escape(host) + @"\)", RegexOptions.None, RegexTimeout);
            if (!render.Success) return false;
            refresh = render.Groups["refresh"].Value + "(" + host + ")";
        }
        body = body.Replace(request,
            "(window.JellyfinInfiniteScroll?window.JellyfinInfiniteScroll.legacy(function(infiniteScrollQuery){return ApiClient.getItems(ApiClient.getCurrentUserId(),infiniteScrollQuery)}," +
            queryName + "," + host + ",function(){return " + refresh + "}):" + request + ")", StringComparison.Ordinal);
        body = body.Replace("window.scrollTo(0,0)",
            "(window.JellyfinInfiniteScroll?window.JellyfinInfiniteScroll.scrollTo(" + host + "):window.scrollTo(0,0))", StringComparison.Ordinal);
        body = Regex.Replace(body, Identifier + @"\.default\.autoFocus\(" + Regex.Escape(host) + @"\)", match =>
            "(window.JellyfinInfiniteScroll?window.JellyfinInfiniteScroll.autoFocus(" + host + ",function(){return " + match.Value + "}):" + match.Value + ")", RegexOptions.None, RegexTimeout);
        patched = source.Remove(start, end - start + 1).Insert(start, body);
        return true;
    }

    public static bool TryPatchLegacyList(string source, out string patched)
    {
        patched = source;
        if (!source.Contains(".queryRecursive=", StringComparison.Ordinal) ||
            !source.Contains("getQueryPagingHtml", StringComparison.Ordinal) ||
            !source.Contains("GenreIds", StringComparison.Ordinal)) return false;

        // The shared /list page is used by genre links in both layouts. Wrap
        // only its displayed list fetch, leaving Play All/Queue/Shuffle alone.
        string pattern = @"(?<instance>" + Identifier + @")\.itemsContainer\.fetchData=function\(\)\{return " + Identifier + @"=!0,(?<request>(?<fetch>" + Identifier + @")\(\k<instance>,(?<parameters>" + Identifier + @"),\k<instance>\.currentItem,null,(?<query>" + Identifier + @")\.StartIndex,\k<query>\.Limit\))\.then\(";
        Match[] requests = Regex.Matches(source, pattern, RegexOptions.None, RegexTimeout).Cast<Match>().ToArray();
        if (requests.Length != 1) return false;
        Match request = requests[0];
        string instance = request.Groups["instance"].Value;
        string parameters = request.Groups["parameters"].Value;
        string setupPattern = Regex.Escape(instance) + @"=this;" + Regex.Escape(instance) + @"\.params=" + Regex.Escape(parameters) + @",this\.itemsContainer=(?<host>" + Identifier + @")\.querySelector\(""\.itemsContainer""\)";
        Match[] setups = Regex.Matches(source[..request.Index], setupPattern, RegexOptions.None, RegexTimeout).Cast<Match>().ToArray();
        if (setups.Length != 1) return false;

        // The same production chunk includes the native items container. Its
        // replacement path also reloads every poster and refocuses a card. Give
        // an active category append a chance to retain its existing DOM, while
        // keeping native refresh bookkeeping and callbacks in both paths.
        if (!TryPatchListRenderer(source, out _)) return false;

        string fetch = request.Groups["fetch"].Value;
        string replacement = "(window.JellyfinInfiniteScroll&&window.JellyfinInfiniteScroll.legacyList?window.JellyfinInfiniteScroll.legacyList(function(infiniteScrollQuery){return " +
            fetch + "(" + instance + "," + parameters + "," + instance + ".currentItem,null,infiniteScrollQuery.StartIndex,infiniteScrollQuery.Limit)}," +
            instance + "," + request.Groups["query"].Value + "," + setups[0].Groups["host"].Value + "):" + request.Groups["request"].Value + ")";
        Group invocation = request.Groups["request"];
        // Patch the request first: renderer edits may change indices earlier in
        // the asset. Re-run its guarded edit against the completed request text.
        string fetching = source.Remove(invocation.Index, invocation.Length).Insert(invocation.Index, replacement);
        return TryPatchListRenderer(fetching, out patched);
    }

    private static bool TryPatchListRenderer(string source, out string patched)
    {
        patched = source;
        string functionPattern = @"function " + Identifier + @"\((?<result>" + Identifier + @")\)(?<body>\{)if\(this\.getItemsHtml\)\{var (?<items>" + Identifier + @")=\k<result>\.Items\|\|\k<result>,";
        Match[] functions = Regex.Matches(source, functionPattern, RegexOptions.None, RegexTimeout).Cast<Match>().ToArray();
        if (functions.Length != 1) return false;
        Match renderer = functions[0];
        int end = FindClosing(source, renderer.Groups["body"].Index);
        if (end < 0) return false;
        string body = source[renderer.Index..(end + 1)];

        string replacementPattern = @"this\.innerHTML=this\.getItemsHtml\(" + Regex.Escape(renderer.Groups["items"].Value) + @"\),(?<loader>" + Identifier + @"(?:\." + Identifier + @")+)\.lazyChildren\(this\)," + Identifier + @"&&function\(" + Identifier + @"," + Identifier + @"\)(?<focusBody>\{)";
        Match[] replacements = Regex.Matches(body, replacementPattern, RegexOptions.None, RegexTimeout).Cast<Match>().ToArray();
        if (replacements.Length != 1) return false;
        Match replacement = replacements[0];
        int focusEnd = FindClosing(body, replacement.Groups["focusBody"].Index);
        if (focusEnd < 0) return false;
        Match focusCall = Regex.Match(body[(focusEnd + 1)..], @"^\(this," + Identifier + @"\)(?=," + Identifier + @"\(this\),this\.afterRefresh&&this\.afterRefresh\(" + Regex.Escape(renderer.Groups["result"].Value) + @"\))", RegexOptions.None, RegexTimeout);
        if (!focusCall.Success) return false;

        int length = focusEnd + 1 + focusCall.Length - replacement.Index;
        string native = body.Substring(replacement.Index, length);
        string append = "(window.JellyfinInfiniteScroll&&window.JellyfinInfiniteScroll.appendList&&window.JellyfinInfiniteScroll.appendList(this," +
            renderer.Groups["result"].Value + ",function(infiniteScrollScope){" + replacement.Groups["loader"].Value +
            ".lazyChildren(infiniteScrollScope)})||(" + native + "))";
        int start = renderer.Index + replacement.Index;
        patched = source.Remove(start, length).Insert(start, append);
        return true;
    }

    private static int Count(string source, string value) => (source.Length - source.Replace(value, string.Empty, StringComparison.Ordinal).Length) / value.Length;

    public static bool TryPatchToolbar(string source, out string patched)
    {
        patched = source;
        if (!source.Contains("libraryPageSize", StringComparison.Ordinal) || !source.Contains("\"ListPaging\"", StringComparison.Ordinal)) return false;
        string pattern = @"(?<enabled>" + Identifier + @")=(?<size>" + Identifier + @")>0,(?<required>" + Identifier + @")=\k<enabled>&&\k<size><(?<total>" + Identifier + @"),(?<count>" + Identifier + @")=\(0," + Identifier + @"\.useMemo\)\(\(?function\(\)\{return " + Identifier + @"\?\""[^\""\r\n]*\"":\k<required>\?" + Identifier + @"\." + Identifier + @"\.translate\(\""ListPaging\"",";
        Match[] matches = Regex.Matches(source, pattern, RegexOptions.None, RegexTimeout).Cast<Match>().ToArray();
        if (matches.Length != 1) return false;
        Match match = matches[0];
        int insertion = match.Index + match.Groups["enabled"].Length + 1 + match.Groups["size"].Length + 2;
        patched = source.Insert(insertion,
            "&&!(window.JellyfinInfiniteScroll&&window.JellyfinInfiniteScroll.paginationDisabled())");
        return true;
    }

    /// <summary>Finds the end of a balanced JavaScript object, skipping quoted strings and comments.</summary>
    public static int FindClosing(string source, int start)
    {
        if (start < 0 || start >= source.Length || source[start] != '{') return -1;
        int depth = 0;
        char quote = '\0';
        bool escaped = false;
        for (int index = start; index < source.Length; index++)
        {
            char value = source[index];
            if (quote != '\0')
            {
                if (escaped) escaped = false;
                else if (value == '\\') escaped = true;
                else if (value == quote) quote = '\0';
                continue;
            }
            if (value is '\'' or '"' or '`') { quote = value; continue; }
            if (value == '/' && index + 1 < source.Length && source[index + 1] == '/')
            {
                int newline = source.IndexOf('\n', index + 2);
                if (newline < 0) return -1;
                index = newline;
                continue;
            }
            if (value == '/' && index + 1 < source.Length && source[index + 1] == '*')
            {
                int end = source.IndexOf("*/", index + 2, StringComparison.Ordinal);
                if (end < 0) return -1;
                index = end + 1;
                continue;
            }
            if (value == '{') depth++;
            else if (value == '}' && --depth == 0) return index;
        }
        return -1;
    }
}
