/* Jellyfin Infinite Scroll: retain native queries, renderers, and item actions. */
(function (window) {
    'use strict';
    if (window.JellyfinInfiniteScroll) return;

    var config = window.JellyfinInfiniteScrollConfig || {};
    var batchSize = Math.min(1000, Math.max(1, Math.floor(Number(config.batchSize) || 100)));
    var completionMessage = typeof config.completionMessage === 'string' ? config.completionMessage : 'All items loaded.';
    var sessions = new Map();
    var currentInvocation = null;
    var active = null;
    var observer = null;
    var sentinel = null;
    var queued = false;
    var supportedViews = new Set([
        'movies', 'series', 'episodes', 'favorites', 'collections', 'playlists',
        'albums', 'albumartists', 'artists', 'authors', 'songs', 'studios',
        'books', 'photoalbums', 'photos', 'videos', 'musicvideos', 'folders', 'mixed'
    ]);

    function isRandom(settings) {
        return String(settings && settings.SortBy || '').toLowerCase().split(',').indexOf('random') !== -1;
    }

    function makeSession(key) {
        var session = sessions.get(key);
        if (!session) {
            session = {
                key: key, items: [], offset: 0, total: undefined, exhausted: false,
                loading: false, append: false, error: null, generation: 0,
                refresh: null, host: null, route: window.location.href, preserveScroll: false
            };
            sessions.set(key, session);
            // React Query retains its own cache; keep this adapter's state bounded.
            if (sessions.size > 24) {
                var oldest = sessions.keys().next().value;
                if (!active || oldest !== active.key) sessions.delete(oldest);
            }
        }
        return session;
    }

    function reset(session) {
        session.items = [];
        session.offset = 0;
        session.total = undefined;
        session.exhausted = false;
        session.error = null;
    }

    function merge(session, result, offset) {
        if (!result || !Array.isArray(result.Items)) throw new Error('Unexpected library response.');
        var seen = new Set(session.items.map(function (item) { return item.Id; }).filter(Boolean));
        result.Items.forEach(function (item) {
            if (!item.Id || !seen.has(item.Id)) {
                session.items.push(item);
                if (item.Id) seen.add(item.Id);
            }
        });
        // Advance by the server's raw count, even when duplicate IDs are removed.
        session.offset = offset + result.Items.length;
        session.total = Number.isFinite(result.TotalRecordCount) ? result.TotalRecordCount : undefined;
        session.exhausted = result.Items.length === 0 ||
            (session.total !== undefined ? session.offset >= session.total : result.Items.length < batchSize);
        return Object.assign({}, result, {
            Items: session.items.slice(), StartIndex: 0,
            __jellyfinInfiniteScroll: { offset: session.offset, exhausted: session.exhausted }
        });
    }

    async function fetchBatch(session, fetcher, context) {
        var append = session.append;
        session.append = false;
        if (!append) reset(session);
        var offset = session.offset;
        var generation = ++session.generation;
        session.loading = true;
        session.error = null;
        schedule();
        try {
            var previous = currentInvocation;
            currentInvocation = { session: session, offset: offset };
            var request;
            try {
                request = fetcher(context);
            } finally {
                currentInvocation = previous;
            }
            var result = await request;
            if (context && context.signal && context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (generation !== session.generation) throw new DOMException('Superseded', 'AbortError');
            return merge(session, result, offset);
        } catch (error) {
            if (generation !== session.generation) throw new DOMException('Superseded', 'AbortError');
            if (generation === session.generation && error.name !== 'AbortError' && error.name !== 'CanceledError') {
                session.error = error;
            }
            throw error;
        } finally {
            if (generation === session.generation) session.loading = false;
            schedule();
        }
    }

    function settings(value) {
        if (!currentInvocation) return value;
        return Object.assign({}, value, {
            StartIndex: currentInvocation.offset,
            __jellyfinInfiniteScrollBatchSize: batchSize
        });
    }

    // Called in the native hook's render, with Jellyfin's own useQuery function.
    function useQuery(nativeUseQuery, options) {
        var key = options.queryKey;
        var viewSettings = key && key[6] && key[6].libraryViewSettings;
        if (config.enabled === false || !key || key[4] !== 'ViewByType' ||
            !supportedViews.has(key[5]) || isRandom(viewSettings) || !options.enabled) {
            active = null;
            detach();
            return nativeUseQuery(options);
        }
        var session = makeSession(JSON.stringify(key));
        var wrapped = Object.assign({}, options, {
            // A failed appended batch is retried explicitly through the sentinel.
            retry: false,
            queryFn: function (context) { return fetchBatch(session, options.queryFn, context); }
        });
        var result = nativeUseQuery(wrapped);
        if (!result.isPlaceholderData) {
            if (!session.loading && !session.error && result.data && Array.isArray(result.data.Items)) {
                var metadata = result.data.__jellyfinInfiniteScroll;
                session.items = result.data.Items.slice();
                session.offset = metadata ? metadata.offset : session.items.length;
                session.total = Number.isFinite(result.data.TotalRecordCount) ? result.data.TotalRecordCount : undefined;
                session.exhausted = metadata ? metadata.exhausted :
                    (session.total !== undefined && session.offset >= session.total);
            }
            session.refresh = function () { return result.refetch({ cancelRefetch: false, throwOnError: true }); };
            session.route = window.location.href;
            session.host = null;
            active = session;
            schedule();
        } else {
            active = null;
            detach();
        }
        return result;
    }

    function legacy(fetcher, query, host, refresh) {
        if (config.enabled === false || isRandom(query)) {
            active = null;
            detach();
            return fetcher(query);
        }
        var identity = Object.assign({}, query);
        delete identity.StartIndex;
        delete identity.Limit;
        var userId = window.ApiClient && window.ApiClient.getCurrentUserId();
        var session = makeSession('legacy:' + userId + ':' + window.location.href + ':' + JSON.stringify(identity));
        session.host = host;
        session.refresh = refresh;
        session.route = window.location.href;
        active = session;
        query.StartIndex = 0;
        query.Limit = batchSize;
        var appending = session.append;
        return fetchBatch(session, function () {
            return fetcher(Object.assign({}, query, { StartIndex: session.offset, Limit: batchSize }));
        }).catch(function (error) {
            if (active !== session || session.route !== window.location.href) throw new DOMException('Superseded', 'AbortError');
            if (error.name === 'AbortError' || error.name === 'CanceledError') throw error;
            // Finish the native refresh so its loading indicator and controls are
            // released, while the sentinel exposes a retry at the failed offset.
            return { Items: session.items.slice(), TotalRecordCount: session.total || 0, StartIndex: 0 };
        }).then(function (result) {
            if (active !== session || session.route !== window.location.href) throw new DOMException('Superseded', 'AbortError');
            session.preserveScroll = appending;
            window.setTimeout(function () { session.preserveScroll = false; }, 250);
            return result;
        });
    }

    function scrollTo(host) {
        if (active && active.host === host && active.preserveScroll) return;
        window.scrollTo(0, 0);
    }

    function autoFocus(host, callback) {
        if (active && active.host === host && active.preserveScroll) return;
        return callback();
    }

    function paginationDisabled() {
        return !!(active && !active.host && active.route === window.location.href);
    }

    function detach() {
        if (observer) observer.disconnect();
        observer = null;
        if (sentinel) sentinel.remove();
        sentinel = null;
        window.document.querySelectorAll('[data-jellyfin-infinite-scroll-paging]').forEach(function (element) {
            element.hidden = false;
            element.removeAttribute('data-jellyfin-infinite-scroll-paging');
        });
    }

    function visible(element) {
        return element.isConnected && element.getClientRects().length > 0 && !element.closest('.hide, [hidden]');
    }

    function getHost(session) {
        if (session.host) return visible(session.host) ? session.host.querySelector('.itemsContainer') : null;
        return Array.from(window.document.querySelectorAll('.itemsContainer.vertical-wrap, .itemsContainer.vertical-list'))
            .find(visible) || null;
    }

    function hidePaging(session) {
        var document = window.document;
        var buttons = session.host ? session.host.querySelectorAll('.paging') :
            Array.from(document.querySelectorAll('.MuiButtonGroup-root')).filter(function (group) {
                return group.querySelector('[data-testid="NavigateNextIcon"]') &&
                    group.querySelector('[data-testid="NavigateBeforeIcon"]');
            });
        Array.from(buttons).forEach(function (element) {
            if (!element.hasAttribute('data-jellyfin-infinite-scroll-paging')) {
                element.setAttribute('data-jellyfin-infinite-scroll-paging', '');
                element.hidden = true;
            }
        });
    }

    function loadMore() {
        var session = active;
        if (!session || session.loading || session.append || session.exhausted || !session.refresh ||
            session.route !== window.location.href || !getHost(session)) return;
        session.append = true;
        session.error = null;
        schedule();
        Promise.resolve().then(session.refresh).catch(function (error) {
            session.append = false;
            if (error.name !== 'AbortError' && error.name !== 'CanceledError' && active === session &&
                session.route === window.location.href) session.error = error;
        }).finally(schedule);
    }

    function render() {
        queued = false;
        var session = active;
        if (!session || session.route !== window.location.href) {
            detach();
            return;
        }
        var host = getHost(session);
        if (!host) {
            detach();
            return;
        }
        hidePaging(session);
        if (!sentinel || sentinel.previousElementSibling !== host) {
            if (observer) observer.disconnect();
            if (sentinel) sentinel.remove();
            sentinel = window.document.createElement('div');
            sentinel.className = 'jellyfin-infinite-scroll-sentinel';
            sentinel.style.cssText = 'text-align:center;padding:1.5em;min-height:2em;';
            sentinel.setAttribute('role', 'status');
            sentinel.setAttribute('aria-live', 'polite');
            host.insertAdjacentElement('afterend', sentinel);
            if ('IntersectionObserver' in window) {
                observer = new window.IntersectionObserver(function (entries) {
                    if (entries.some(function (entry) { return entry.isIntersecting; }) && active && !active.error) loadMore();
                }, { rootMargin: '400px 0px' });
                observer.observe(sentinel);
            }
        }
        var text = session.loading || session.append ? 'Loading more items…' :
            session.error ? 'Could not load more items. ' :
                session.exhausted ? (session.items.length ? completionMessage : '') : '';
        var signature = text + ':' + session.items.length;
        if (sentinel.getAttribute('data-status') !== signature) {
            sentinel.setAttribute('data-status', signature);
            sentinel.textContent = text;
            if (session.error || (!observer && !session.exhausted && !session.loading)) {
                var button = window.document.createElement('button');
                button.type = 'button';
                button.className = 'raised button-submit emby-button';
                button.textContent = session.error ? 'Retry' : 'Load more';
                button.addEventListener('click', loadMore);
                sentinel.appendChild(button);
            }
        }
        sentinel.setAttribute('aria-busy', String(session.loading || session.append));
        sentinel.style.display = session.exhausted && !text ? 'none' : '';
        // Recheck after every append, including when the sentinel stays in view.
        if (observer && !session.loading && !session.append && !session.error && !session.exhausted &&
            sentinel.getBoundingClientRect().top < window.innerHeight + 400) {
            window.setTimeout(loadMore, 0);
        }
    }

    function schedule() {
        if (queued) return;
        queued = true;
        window.requestAnimationFrame(render);
    }

    function navigated() {
        active = null;
        detach();
    }

    window.JellyfinInfiniteScroll = {
        useQuery: useQuery, settings: settings, legacy: legacy, scrollTo: scrollTo, autoFocus: autoFocus,
        paginationDisabled: paginationDisabled, batchSize: batchSize
    };
    window.addEventListener('hashchange', navigated);
    window.addEventListener('popstate', navigated);
    window.addEventListener('pagehide', navigated);
    function start() {
        var style = window.document.createElement('style');
        style.textContent = '[data-jellyfin-infinite-scroll-paging]{display:none!important}';
        window.document.head.appendChild(style);
        new window.MutationObserver(schedule).observe(window.document.body, { childList: true, subtree: true });
    }
    if (window.document.body) start();
    else window.document.addEventListener('DOMContentLoaded', start, { once: true });
})(window);
