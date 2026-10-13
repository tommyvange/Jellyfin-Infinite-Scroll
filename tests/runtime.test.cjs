'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname,
    '../src/Jellyfin.Plugin.InfiniteScroll/Web/infinite-scroll.js'), 'utf8');

// A small DOM boundary, so the tests exercise the shipped script without a
// browser, npm dependencies, or exposing its private session state.
function createHarness(config = {}, { intersectionObserver = true } = {}) {
    const animationFrames = [];
    const timers = [];
    const events = new Map();
    const mutationObservers = [];
    const intersectionObservers = [];
    const scrollCalls = [];
    let sentinelTop = 2000;

    function matches(element, selector) {
        return selector.split(',').some((part) => {
            part = part.trim();
            if (part.startsWith('.')) {
                return part.slice(1).split('.').every((name) => element.className.split(/\s+/).includes(name));
            }
            const attribute = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
            if (attribute) {
                return attribute[1] === 'hidden' ? element.hidden :
                    element.hasAttribute(attribute[1]) &&
                    (attribute[2] === undefined || element.getAttribute(attribute[1]) === attribute[2]);
            }
            return element.tagName.toLowerCase() === part.toLowerCase();
        });
    }

    class Element {
        constructor(tagName = 'div', className = '') {
            this.tagName = tagName.toUpperCase();
            this.className = className;
            this.style = {};
            this.hidden = false;
            this.children = [];
            this.parentNode = null;
            this.attributes = new Map();
            this.listeners = new Map();
            this.ownText = '';
        }
        get isConnected() {
            return this === document.body || this === document.head || Boolean(this.parentNode && this.parentNode.isConnected);
        }
        get previousElementSibling() {
            if (!this.parentNode) return null;
            return this.parentNode.children[this.parentNode.children.indexOf(this) - 1] || null;
        }
        get textContent() {
            return this.ownText + this.children.map((child) => child.textContent).join('');
        }
        set textContent(value) {
            this.children.forEach((child) => { child.parentNode = null; });
            this.children = [];
            this.ownText = String(value);
        }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
        hasAttribute(name) { return this.attributes.has(name); }
        removeAttribute(name) { this.attributes.delete(name); }
        appendChild(child) {
            child.remove();
            child.parentNode = this;
            this.children.push(child);
            return child;
        }
        remove() {
            if (this.parentNode) {
                const siblings = this.parentNode.children;
                siblings.splice(siblings.indexOf(this), 1);
                this.parentNode = null;
            }
        }
        insertAdjacentElement(position, element) {
            assert.equal(position, 'afterend');
            element.remove();
            const siblings = this.parentNode.children;
            siblings.splice(siblings.indexOf(this) + 1, 0, element);
            element.parentNode = this.parentNode;
        }
        querySelectorAll(selector) {
            const descendants = [];
            for (const child of this.children) {
                if (matches(child, selector)) descendants.push(child);
                descendants.push(...child.querySelectorAll(selector));
            }
            return descendants;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) {
            for (let node = this; node; node = node.parentNode) {
                if (matches(node, selector)) return node;
            }
            return null;
        }
        getClientRects() { return this.isConnected && !this.closest('.hide, [hidden]') ? [{}] : []; }
        getBoundingClientRect() { return { top: sentinelTop }; }
        addEventListener(name, listener) { this.listeners.set(name, listener); }
        click() {
            assert.ok(this.listeners.has('click'), 'button has a click handler');
            this.listeners.get('click')({ target: this });
        }
    }

    const document = {
        body: new Element('body'),
        head: new Element('head'),
        createElement: (name) => new Element(name),
        querySelectorAll: (selector) => document.body.querySelectorAll(selector),
        querySelector: (selector) => document.body.querySelector(selector),
        addEventListener() {}
    };
    const host = new Element('div', 'itemsContainer vertical-wrap');
    document.body.appendChild(host);
    const pager = new Element('div', 'MuiButtonGroup-root');
    for (const icon of ['NavigateBeforeIcon', 'NavigateNextIcon']) {
        const button = new Element('button');
        button.setAttribute('data-testid', icon);
        pager.appendChild(button);
    }
    document.body.appendChild(pager);

    const window = {
        JellyfinInfiniteScrollConfig: config,
        document,
        location: { href: 'https://jellyfin.example/web/#/movies.html?topParentId=movies' },
        innerHeight: 800,
        ApiClient: { getCurrentUserId: () => 'user-1' },
        scrollTo: (...args) => scrollCalls.push(args),
        addEventListener: (name, callback) => events.set(name, callback),
        requestAnimationFrame: (callback) => animationFrames.push(callback),
        setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; mutationObservers.push(this); }
            observe(target, options) { this.target = target; this.options = options; }
        }
    };
    if (intersectionObserver) {
        window.IntersectionObserver = class {
            constructor(callback, options) {
                this.callback = callback;
                this.options = options;
                this.targets = [];
                this.disconnected = false;
                intersectionObservers.push(this);
            }
            observe(target) { this.targets.push(target); }
            disconnect() { this.disconnected = true; this.targets = []; }
        };
    }
    vm.runInNewContext(source, { window, DOMException }, { filename: 'infinite-scroll.js' });

    const harness = {
        window, document, host, pager, Element, timers, intersectionObservers,
        mutationObservers, scrollCalls,
        runtime: window.JellyfinInfiniteScroll,
        get sentinel() { return document.querySelector('.jellyfin-infinite-scroll-sentinel'); },
        setSentinelTop(top) { sentinelTop = top; },
        frames() {
            let count = 0;
            while (animationFrames.length) {
                assert.ok(++count < 30, 'render does not continually schedule itself');
                animationFrames.shift()();
            }
        },
        mutate() { mutationObservers.forEach((observer) => observer.callback([])); },
        intersect(value = true) {
            const observer = intersectionObservers.filter((entry) => !entry.disconnected).at(-1);
            assert.ok(observer, 'sentinel is observed');
            observer.callback([{ isIntersecting: value }]);
        },
        runTimers(delay = 0) {
            const callbacks = timers.filter((entry) => entry.delay === delay);
            for (const entry of callbacks) timers.splice(timers.indexOf(entry), 1);
            callbacks.forEach((entry) => entry.callback());
        },
        navigate(href, event = 'hashchange') {
            window.location.href = href;
            events.get(event)();
        },
        async settle() {
            // Allow the native refetch, loadMore's error handler and finally
            // callback to run, then render their resulting state.
            await new Promise((resolve) => setImmediate(resolve));
            this.frames();
        }
    };
    return harness;
}

function key(view = 'movies', settings = {}, { library = 'library-1', user = 'user-1' } = {}) {
    return ['Items', user, library, 'items', 'ViewByType', view, { libraryViewSettings: settings }];
}

function queryOptions(queryKey, queryFn, extra = {}) {
    return { queryKey, queryFn, enabled: true, staleTime: 60_000, retry: 3, ...extra };
}

function nativeQuery() {
    let options;
    const calls = [];
    const fetches = [];
    const result = {
        data: undefined,
        isPlaceholderData: false,
        refetch(refetchOptions) {
            calls.push(refetchOptions);
            return controller.fetch();
        }
    };
    const controller = {
        result, calls, fetches,
        get options() { return options; },
        useQuery(value) { options = value; return result; },
        async fetch(context = { signal: new AbortController().signal }) {
            fetches.push(context);
            const data = await options.queryFn(context);
            result.data = data;
            return { data };
        }
    };
    return controller;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function ids(result) { return Array.from(result.Items, (item) => item.Id); }
function items(...values) { return values.map((Id) => ({ Id, Name: Id })); }
function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function legacyPage(h) {
    h.host.remove();
    const page = new h.Element('div', 'page');
    const pager = new h.Element('div', 'paging');
    page.appendChild(h.host);
    page.appendChild(pager);
    h.document.body.appendChild(page);
    return { page, pager };
}

test('configuration defaults to 100 and clamps positive sizes to 1–1000', () => {
    for (const [value, expected] of [
        [undefined, 100], ['invalid', 100], [0, 100], [-20, 1], [1, 1],
        [12.9, 12], ['50', 50], [1001, 1000]
    ]) {
        assert.equal(createHarness({ batchSize: value }).runtime.batchSize, expected);
    }
});

test('completion messages support custom plain text, blank hiding, and older configurations in both layouts', async () => {
    for (const layout of ['modern', 'legacy']) {
        for (const [message, expected] of [
            [undefined, 'All items loaded.'],
            [null, 'All items loaded.'],
            ['That is everything!', 'That is everything!'],
            ['Alle filmer er lastet inn 🎬', 'Alle filmer er lastet inn 🎬'],
            ['<b>Done</b> & "complete"', '<b>Done</b> & "complete"'],
            ['', '']
        ]) {
            const h = createHarness({ completionMessage: message });
            const response = { Items: items('movie-1'), TotalRecordCount: 1 };
            if (layout === 'modern') {
                const native = nativeQuery();
                h.runtime.useQuery(native.useQuery, queryOptions(key(), () => Promise.resolve(response)));
                await native.fetch();
            } else {
                const { page } = legacyPage(h);
                await h.runtime.legacy(() => Promise.resolve(response), { SortBy: 'SortName' }, page, () => {});
            }
            h.frames();
            assert.equal(h.sentinel.textContent, expected, `${layout}: configured text is displayed literally`);
            assert.equal(h.sentinel.children.length, 0, 'plain text is not interpreted as markup');
            assert.equal(h.sentinel.style.display, expected === '' ? 'none' : '', `${layout}: blank text leaves no completion-message gap`);
            assert.equal(h.sentinel.getAttribute('aria-busy'), 'false');
        }
    }
});

test('modern wrapper preserves native query options, result, signal, and library filters', async () => {
    const h = createHarness();
    const native = nativeQuery();
    const originalSettings = { StartIndex: 900, SortBy: 'SortName', SearchTerm: 'test', Filters: 'IsFavorite' };
    let requested;
    let passedContext;
    const options = queryOptions(key('movies', originalSettings), (context) => {
        passedContext = context;
        requested = h.runtime.settings(originalSettings);
        return Promise.resolve({ Items: items('movie-1'), TotalRecordCount: 1 });
    }, { select: (response) => response, gcTime: 1234, meta: { library: true } });
    assert.strictEqual(h.runtime.useQuery(native.useQuery, options), native.result);
    for (const name of ['queryKey', 'enabled', 'staleTime', 'select', 'gcTime', 'meta']) {
        assert.strictEqual(native.options[name], options[name], `${name} is preserved`);
    }
    assert.notStrictEqual(native.options.queryFn, options.queryFn);
    assert.equal(native.options.retry, false, 'appended batches use explicit retry');
    const context = { signal: new AbortController().signal, queryKey: options.queryKey, meta: options.meta };
    await native.fetch(context);
    h.frames();
    assert.strictEqual(passedContext, context);
    assert.deepEqual(plain(requested), {
        ...originalSettings, StartIndex: 0, __jellyfinInfiniteScrollBatchSize: 100
    });
    assert.equal(originalSettings.StartIndex, 900, 'native settings are not mutated');
    assert.strictEqual(h.runtime.settings(originalSettings), originalSettings, 'override is scoped to the fetch');
    assert.deepEqual(ids(native.result.data), ['movie-1']);
    assert.equal(native.result.data.StartIndex, 0);
    assert.equal(h.pager.hidden, true);
    assert.equal(h.runtime.paginationDisabled(), true);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
    assert.equal(h.sentinel.getAttribute('role'), 'status');
    assert.equal(h.sentinel.getAttribute('aria-live'), 'polite');
    assert.equal(h.sentinel.getAttribute('aria-busy'), 'false');
});

test('disabled queries, random sorting, unsupported views, and disabled plugin use native options', () => {
    for (const [config, queryKey, enabled] of [
        [{ enabled: false }, key(), true],
        [{}, key(), false],
        [{}, key(), undefined],
        [{}, key('movies', { SortBy: 'Random' }), true],
        [{}, key('movies', { SortBy: 'SortName,Random' }), true],
        [{}, key('unsupported'), true],
        [{}, ['Items', 'user-1'], true]
    ]) {
        const h = createHarness(config);
        const native = nativeQuery();
        const options = queryOptions(queryKey, () => { throw new Error('native owns this request'); }, { enabled });
        assert.strictEqual(h.runtime.useQuery(native.useQuery, options), native.result);
        assert.strictEqual(native.options, options);
        h.frames();
        assert.equal(h.sentinel, null);
        assert.equal(h.pager.hidden, false);
        assert.equal(h.runtime.paginationDisabled(), false);
    }
});

test('switching an active library to native paging detaches the prior sentinel on the same route', async () => {
    for (const optionsForFallback of [
        () => queryOptions(key(), () => {}, { enabled: false }),
        () => queryOptions(key('movies', { SortBy: 'Random' }), () => {}),
        () => queryOptions(key('unsupported'), () => {})
    ]) {
        const h = createHarness({ batchSize: 1 });
        const native = nativeQuery();
        h.runtime.useQuery(native.useQuery, queryOptions(key(), () => Promise.resolve({
            Items: items('a'), TotalRecordCount: 5
        })));
        await native.fetch();
        h.frames();
        const observer = h.intersectionObservers.at(-1);
        const fallback = optionsForFallback();
        h.runtime.useQuery(native.useQuery, fallback);
        assert.strictEqual(native.options, fallback);
        assert.equal(h.sentinel, null);
        assert.equal(h.pager.hidden, false);
        assert.equal(observer.disconnected, true);
        // An observer delivery already queued before disconnection and a later
        // DOM mutation must both remain harmless after changing sort/view.
        observer.callback([{ isIntersecting: true }]);
        h.mutate();
        await h.settle();
        assert.equal(h.sentinel, null);
        assert.equal(native.calls.length, 0);
    }
});

test('intersection appends a batch, advances by raw server count, and stops at total', async () => {
    const h = createHarness({ batchSize: 2 });
    const native = nativeQuery();
    const requested = [];
    const responses = [
        { Items: items('a', 'b'), TotalRecordCount: 5 },
        { Items: items('b', 'c'), TotalRecordCount: 5 },
        { Items: items('d'), TotalRecordCount: 5 }
    ];
    const settings = { StartIndex: 10, SortBy: 'SortName', SortOrder: 'Ascending', SearchTerm: 'kept' };
    const options = queryOptions(key('series', settings), () => {
        requested.push(plain(h.runtime.settings(settings)));
        return Promise.resolve(responses.shift());
    });
    h.runtime.useQuery(native.useQuery, options);
    await native.fetch();
    h.frames();
    assert.deepEqual(ids(native.result.data), ['a', 'b']);
    assert.equal(h.intersectionObservers[0].options.rootMargin, '400px 0px');
    h.intersect(false);
    await h.settle();
    assert.equal(native.calls.length, 0);
    h.intersect();
    h.intersect();
    await h.settle();
    assert.equal(native.calls.length, 1, 'repeated intersections do not duplicate an in-flight append');
    assert.deepEqual(plain(native.calls[0]), { cancelRefetch: false, throwOnError: true });
    assert.deepEqual(ids(native.result.data), ['a', 'b', 'c']);
    assert.equal(native.result.data.__jellyfinInfiniteScroll.offset, 4);
    h.intersect();
    await h.settle();
    assert.deepEqual(ids(native.result.data), ['a', 'b', 'c', 'd']);
    assert.deepEqual(requested.map((request) => request.StartIndex), [0, 2, 4]);
    assert.ok(requested.every((request) => request.__jellyfinInfiniteScrollBatchSize === 2));
    assert.ok(requested.every((request) => request.SearchTerm === 'kept' && request.SortOrder === 'Ascending'));
    assert.equal(native.result.data.__jellyfinInfiniteScroll.exhausted, true);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
    h.intersect();
    await h.settle();
    assert.equal(native.calls.length, 2, 'exhausted library cannot request another batch');
});

test('manual load button works without IntersectionObserver and detects a short final batch', async () => {
    const h = createHarness({ batchSize: 2 }, { intersectionObserver: false });
    const native = nativeQuery();
    const responses = [{ Items: items('a', 'b') }, { Items: items('c') }];
    h.runtime.useQuery(native.useQuery, queryOptions(key(), () => Promise.resolve(responses.shift())));
    await native.fetch();
    h.frames();
    const loadButton = h.sentinel.querySelector('button');
    assert.equal(loadButton.textContent, 'Load more');
    loadButton.click();
    await h.settle();
    assert.deepEqual(ids(native.result.data), ['a', 'b', 'c']);
    assert.equal(h.sentinel.querySelector('button'), null);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
});

test('an empty library stops immediately and leaves its native empty-state presentation available', async () => {
    const h = createHarness();
    const native = nativeQuery();
    h.runtime.useQuery(native.useQuery, queryOptions(key(), () => Promise.resolve({
        Items: [], TotalRecordCount: 0
    })));
    await native.fetch();
    h.frames();
    assert.deepEqual(ids(native.result.data), []);
    assert.equal(native.result.data.__jellyfinInfiniteScroll.exhausted, true);
    assert.equal(h.sentinel.textContent, '');
    h.intersect();
    await h.settle();
    assert.equal(native.calls.length, 0);
});

test('failed appended batch preserves items and offset, then Retry requests the same offset', async () => {
    const h = createHarness({ batchSize: 2 });
    const native = nativeQuery();
    const requested = [];
    let attempt = 0;
    const options = queryOptions(key(), () => {
        requested.push(h.runtime.settings({}).StartIndex);
        attempt++;
        if (attempt === 1) return Promise.resolve({ Items: items('a', 'b'), TotalRecordCount: 4 });
        if (attempt === 2) return Promise.reject(new Error('network unavailable'));
        return Promise.resolve({ Items: items('c', 'd'), TotalRecordCount: 4 });
    });
    h.runtime.useQuery(native.useQuery, options);
    await native.fetch();
    h.frames();
    h.intersect();
    await h.settle();
    assert.deepEqual(ids(native.result.data), ['a', 'b']);
    assert.deepEqual(requested, [0, 2]);
    assert.match(h.sentinel.textContent, /Could not load more items/);
    assert.equal(h.sentinel.getAttribute('aria-busy'), 'false');
    h.runtime.useQuery(native.useQuery, options);
    h.frames();
    assert.match(h.sentinel.textContent, /Could not load more items/, 'native error rerender preserves retry state');
    h.intersect();
    await h.settle();
    assert.equal(attempt, 2, 'intersection does not spin on failed requests');
    const retryButton = h.sentinel.querySelector('button');
    assert.equal(retryButton.textContent, 'Retry');
    retryButton.click();
    await h.settle();
    assert.deepEqual(requested, [0, 2, 2]);
    assert.deepEqual(ids(native.result.data), ['a', 'b', 'c', 'd']);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
});

test('query key separates user, library, sort, and filters, and a normal refetch resets accumulated items', async () => {
    const h = createHarness({ batchSize: 1 });
    const native = nativeQuery();
    const requested = [];
    let item = 0;
    const fetch = () => {
        requested.push(h.runtime.settings({}).StartIndex);
        return Promise.resolve({ Items: items(`item-${++item}`), TotalRecordCount: 10 });
    };
    const queryKeys = [
        key(),
        key('movies', {}, { user: 'user-2' }),
        key('movies', {}, { library: 'library-2' }),
        key('movies', { SortBy: 'DateCreated', SortOrder: 'Descending' }),
        key('movies', { Filters: 'IsFavorite', SearchTerm: 'search' })
    ];
    for (const queryKey of queryKeys) {
        native.result.data = undefined;
        h.runtime.useQuery(native.useQuery, queryOptions(queryKey, fetch));
        await native.fetch();
        h.frames();
        assert.equal(native.result.data.Items.length, 1, 'new query starts a fresh library');
        h.intersect();
        await h.settle();
        assert.equal(native.result.data.Items.length, 2);
    }
    assert.deepEqual(requested, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    await native.fetch();
    h.frames();
    assert.equal(requested.at(-1), 0);
    assert.deepEqual(ids(native.result.data), ['item-11'], 'native refresh replaces previous accumulated data');
});

test('cached query metadata preserves the raw offset after remounting the native hook', async () => {
    const h = createHarness({ batchSize: 2 });
    const native = nativeQuery();
    const requested = [];
    const responses = [
        { Items: items('a', 'a'), TotalRecordCount: 4 },
        { Items: items('b', 'c'), TotalRecordCount: 4 }
    ];
    const options = queryOptions(key(), () => {
        requested.push(h.runtime.settings({}).StartIndex);
        return Promise.resolve(responses.shift());
    });
    h.runtime.useQuery(native.useQuery, options);
    await native.fetch();
    h.runtime.useQuery(native.useQuery, options);
    h.frames();
    assert.deepEqual(ids(native.result.data), ['a']);
    h.intersect();
    await h.settle();
    assert.deepEqual(requested, [0, 2]);
    assert.deepEqual(ids(native.result.data), ['a', 'b', 'c']);
});

test('an aborted response is rejected before merging and the next fetch starts at zero', async () => {
    const h = createHarness({ batchSize: 2 });
    const native = nativeQuery();
    const response = deferred();
    const requested = [];
    let calls = 0;
    h.runtime.useQuery(native.useQuery, queryOptions(key(), () => {
        requested.push(h.runtime.settings({}).StartIndex);
        return ++calls === 1 ? response.promise : Promise.resolve({ Items: items('fresh'), TotalRecordCount: 1 });
    }));
    const abort = new AbortController();
    const fetch = native.fetch({ signal: abort.signal });
    const rejected = assert.rejects(fetch, { name: 'AbortError' });
    abort.abort();
    response.resolve({ Items: items('obsolete'), TotalRecordCount: 1 });
    await rejected;
    assert.equal(native.result.data, undefined);
    await native.fetch();
    h.frames();
    assert.deepEqual(requested, [0, 0]);
    assert.deepEqual(ids(native.result.data), ['fresh']);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
});

test('a slower superseded response cannot overwrite a newer result', async () => {
    const h = createHarness();
    const native = nativeQuery();
    const older = deferred();
    const newer = deferred();
    let calls = 0;
    h.runtime.useQuery(native.useQuery, queryOptions(key(), () => (++calls === 1 ? older : newer).promise));
    const first = native.fetch();
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const second = native.fetch();
    newer.resolve({ Items: items('newer'), TotalRecordCount: 1 });
    await second;
    older.resolve({ Items: items('older'), TotalRecordCount: 1 });
    await rejected;
    h.frames();
    assert.deepEqual(ids(native.result.data), ['newer']);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
});

test('a superseded append cannot replace a successful newer refresh with a retry error', async () => {
    for (const rejection of [false, true]) {
        const h = createHarness({ batchSize: 1 });
        const native = nativeQuery();
        const olderAppend = deferred();
        let calls = 0;
        h.runtime.useQuery(native.useQuery, queryOptions(key(), () => {
            calls++;
            if (calls === 1) return Promise.resolve({ Items: items('initial'), TotalRecordCount: 5 });
            if (calls === 2) return olderAppend.promise;
            return Promise.resolve({ Items: items('fresh'), TotalRecordCount: 1 });
        }));
        await native.fetch();
        h.frames();
        h.intersect();
        await h.settle();
        assert.equal(h.sentinel.getAttribute('aria-busy'), 'true');
        await native.fetch();
        if (rejection) olderAppend.reject(new Error('stale network failure'));
        else olderAppend.resolve({ Items: items('obsolete'), TotalRecordCount: 5 });
        await h.settle();
        assert.deepEqual(ids(native.result.data), ['fresh']);
        assert.equal(h.sentinel.textContent, 'All items loaded.', rejection ? 'stale rejection' : 'stale response');
        assert.equal(h.sentinel.querySelector('button'), null);
    }
});

test('cancelled appended batches keep their items and can load again from the same offset', async () => {
    for (const name of ['AbortError', 'CanceledError']) {
        const h = createHarness({ batchSize: 1 });
        const native = nativeQuery();
        const requested = [];
        let calls = 0;
        h.runtime.useQuery(native.useQuery, queryOptions(key(), () => {
            requested.push(h.runtime.settings({}).StartIndex);
            calls++;
            if (calls === 1) return Promise.resolve({ Items: items('initial'), TotalRecordCount: 2 });
            if (calls === 2) return Promise.reject(Object.assign(new Error('cancelled'), { name }));
            return Promise.resolve({ Items: items('next'), TotalRecordCount: 2 });
        }));
        await native.fetch();
        h.frames();
        h.intersect();
        await h.settle();
        assert.deepEqual(ids(native.result.data), ['initial']);
        assert.doesNotMatch(h.sentinel.textContent, /Could not load/, name);
        assert.equal(h.sentinel.getAttribute('aria-busy'), 'false');
        h.intersect();
        await h.settle();
        assert.deepEqual(requested, [0, 1, 1]);
        assert.deepEqual(ids(native.result.data), ['initial', 'next']);
    }
});

test('navigation disconnects the observer, removes the sentinel, and restores native pagination', async () => {
    for (const event of ['hashchange', 'popstate', 'pagehide']) {
        const h = createHarness({ batchSize: 1 });
        const native = nativeQuery();
        h.runtime.useQuery(native.useQuery, queryOptions(key(), () => Promise.resolve({ Items: items('a'), TotalRecordCount: 5 })));
        await native.fetch();
        h.frames();
        const observer = h.intersectionObservers.at(-1);
        h.navigate('https://jellyfin.example/web/#/home.html', event);
        assert.equal(h.sentinel, null);
        assert.equal(h.pager.hidden, false);
        assert.equal(h.pager.hasAttribute('data-jellyfin-infinite-scroll-paging'), false);
        assert.equal(h.runtime.paginationDisabled(), false);
        assert.equal(observer.disconnected, true);
        observer.callback([{ isIntersecting: true }]);
        await h.settle();
        assert.equal(native.calls.length, 0, 'obsolete observer cannot load another page');
    }
});

test('placeholder data detaches the prior library until the actual query data is ready', async () => {
    const h = createHarness({ batchSize: 1 });
    const native = nativeQuery();
    const options = queryOptions(key(), () => Promise.resolve({ Items: items('a'), TotalRecordCount: 5 }));
    h.runtime.useQuery(native.useQuery, options);
    await native.fetch();
    h.frames();
    native.result.isPlaceholderData = true;
    h.runtime.useQuery(native.useQuery, queryOptions(key('series'), options.queryFn));
    assert.equal(h.sentinel, null);
    assert.equal(h.pager.hidden, false);
    h.mutate();
    h.frames();
    assert.equal(h.sentinel, null, 'pending query does not reactivate the prior session after a mutation');
});

test('mutation scheduling finds a replaced library container and hides its native pager', async () => {
    const h = createHarness({ batchSize: 1 });
    const native = nativeQuery();
    h.runtime.useQuery(native.useQuery, queryOptions(key(), () => Promise.resolve({ Items: items('a'), TotalRecordCount: 5 })));
    await native.fetch();
    h.frames();
    assert.strictEqual(h.mutationObservers[0].target, h.document.body);
    assert.deepEqual(plain(h.mutationObservers[0].options), { childList: true, subtree: true });
    h.host.remove();
    h.mutate();
    h.frames();
    assert.equal(h.sentinel, null);
    assert.equal(h.pager.hidden, false);
    const replacement = new h.Element('div', 'itemsContainer vertical-list');
    h.document.body.appendChild(replacement);
    h.mutate();
    h.frames();
    assert.strictEqual(h.sentinel.previousElementSibling, replacement);
    assert.equal(h.pager.hidden, true);
});

test('observer continues loading if an appended batch leaves the sentinel within the viewport', async () => {
    const h = createHarness({ batchSize: 1 });
    const native = nativeQuery();
    let count = 0;
    h.runtime.useQuery(native.useQuery, queryOptions(key(), () => Promise.resolve({
        Items: items(`item-${++count}`), TotalRecordCount: 3
    })));
    await native.fetch();
    h.frames();
    h.setSentinelTop(900);
    h.intersect();
    await h.settle();
    assert.equal(count, 2);
    assert.ok(h.timers.some((entry) => entry.delay === 0));
    h.runTimers();
    await h.settle();
    assert.equal(count, 3);
    assert.deepEqual(ids(native.result.data), ['item-1', 'item-2', 'item-3']);
    h.runTimers();
    await h.settle();
    assert.equal(count, 3);
});

test('legacy adapter retains filters, disables pagination, appends, and preserves the current scroll position', async () => {
    const h = createHarness({ batchSize: 2 }, { intersectionObserver: false });
    const { page, pager: legacyPager } = legacyPage(h);
    const query = { StartIndex: 20, Limit: 20, ParentId: 'library-1', SortBy: 'SortName', Filters: 'IsFavorite' };
    const requested = [];
    const responses = [
        { Items: items('a', 'b'), TotalRecordCount: 3 },
        { Items: items('c'), TotalRecordCount: 3 }
    ];
    const fetch = (settings) => {
        requested.push({ ...settings });
        return Promise.resolve(responses.shift());
    };
    let result;
    let focusCalls = 0;
    const refresh = async () => {
        result = await h.runtime.legacy(fetch, query, page, refresh);
        h.runtime.scrollTo(page);
        h.runtime.autoFocus(page, () => { focusCalls++; });
        return result;
    };
    result = await h.runtime.legacy(fetch, query, page, refresh);
    h.frames();
    assert.equal(query.StartIndex, 0);
    assert.equal(query.Limit, 2);
    assert.equal(legacyPager.hidden, true);
    h.runtime.scrollTo(page);
    h.runtime.autoFocus(page, () => { focusCalls++; });
    assert.equal(focusCalls, 1, 'initial load keeps native focus behavior');
    assert.deepEqual(h.scrollCalls, [[0, 0]], 'initial library load can scroll to the top');
    h.scrollCalls.length = 0;
    h.sentinel.querySelector('button').click();
    await h.settle();
    assert.deepEqual(ids(result), ['a', 'b', 'c']);
    assert.deepEqual(requested.map((entry) => entry.StartIndex), [0, 2]);
    assert.ok(requested.every((entry) => entry.Limit === 2 && entry.Filters === 'IsFavorite'));
    assert.deepEqual(h.scrollCalls, [], 'native rerender scroll is suppressed during the append');
    assert.equal(focusCalls, 1, 'appending leaves keyboard focus on the current item');
    h.runTimers(250);
    h.runtime.scrollTo(page);
    h.runtime.autoFocus(page, () => { focusCalls++; });
    assert.equal(focusCalls, 2, 'later navigation can restore native focus');
    assert.deepEqual(h.scrollCalls, [[0, 0]], 'later explicit navigation can scroll to the top');
});

test('legacy appended failures retain the raw offset and Retry requests that batch again', async () => {
    const h = createHarness({ batchSize: 2 }, { intersectionObserver: false });
    const { page, pager } = legacyPage(h);
    const query = { ParentId: 'library-1', Filters: 'IsFavorite', SortBy: 'SortName' };
    const requested = [];
    let attempts = 0;
    let result;
    const fetch = (settings) => {
        requested.push({ ...settings });
        attempts++;
        if (attempts === 1) return Promise.resolve({ Items: items('a', 'b'), TotalRecordCount: 4 });
        if (attempts === 2) return Promise.reject(new Error('legacy network failure'));
        return Promise.resolve({ Items: items('c', 'd'), TotalRecordCount: 4 });
    };
    const refresh = async () => {
        result = await h.runtime.legacy(fetch, query, page, refresh);
        return result;
    };
    result = await h.runtime.legacy(fetch, query, page, refresh);
    h.frames();
    h.sentinel.querySelector('button').click();
    await h.settle();
    assert.deepEqual(ids(result), ['a', 'b']);
    assert.match(h.sentinel.textContent, /Could not load more items/);
    const retry = h.sentinel.querySelector('button');
    assert.equal(retry.textContent, 'Retry');
    retry.click();
    await h.settle();
    assert.deepEqual(requested.map((request) => request.StartIndex), [0, 2, 2]);
    assert.ok(requested.every((request) => request.Limit === 2 && request.Filters === 'IsFavorite'));
    assert.deepEqual(ids(result), ['a', 'b', 'c', 'd']);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
    assert.equal(pager.hidden, true);
});

test('legacy filter changes reset the library while a previous append failure is pending', async () => {
    const h = createHarness({ batchSize: 2 }, { intersectionObserver: false });
    const { page } = legacyPage(h);
    const query = { ParentId: 'library-1', Filters: 'IsUnplayed', SortBy: 'SortName' };
    const pendingAppend = deferred();
    const requested = [];
    let result;
    const fetch = (settings) => {
        requested.push({ ...settings });
        if (settings.Filters === 'IsUnplayed') {
            return settings.StartIndex === 0 ?
                Promise.resolve({ Items: items('old-a', 'old-b'), TotalRecordCount: 6 }) : pendingAppend.promise;
        }
        return Promise.resolve({
            Items: settings.StartIndex === 0 ? items('favorite-a', 'favorite-b') : items('favorite-c', 'favorite-d'),
            TotalRecordCount: 4
        });
    };
    const refresh = async () => {
        result = await h.runtime.legacy(fetch, query, page, refresh);
        return result;
    };
    result = await h.runtime.legacy(fetch, query, page, refresh);
    h.frames();
    h.sentinel.querySelector('button').click();
    await h.settle();
    assert.equal(h.sentinel.getAttribute('aria-busy'), 'true');
    query.Filters = 'IsFavorite';
    result = await h.runtime.legacy(fetch, query, page, refresh);
    pendingAppend.reject(new Error('failure belonging to previous filter'));
    await h.settle();
    assert.deepEqual(ids(result), ['favorite-a', 'favorite-b']);
    assert.doesNotMatch(h.sentinel.textContent, /Could not load more items/);
    assert.equal(h.sentinel.querySelector('button').textContent, 'Load more');
    h.sentinel.querySelector('button').click();
    await h.settle();
    assert.deepEqual(ids(result), ['favorite-a', 'favorite-b', 'favorite-c', 'favorite-d']);
    assert.deepEqual(requested.map(({ Filters, StartIndex }) => [Filters, StartIndex]), [
        ['IsUnplayed', 0], ['IsUnplayed', 2], ['IsFavorite', 0], ['IsFavorite', 2]
    ]);
    assert.equal(h.sentinel.textContent, 'All items loaded.');
});

test('legacy disabled and random queries preserve native paging and query values', async () => {
    for (const [config, sort] of [[{ enabled: false }, 'SortName'], [{}, 'Random']]) {
        const h = createHarness(config);
        const query = { StartIndex: 20, Limit: 20, SortBy: sort };
        let received;
        const response = { Items: items('native'), TotalRecordCount: 21 };
        const result = await h.runtime.legacy((settings) => { received = settings; return Promise.resolve(response); }, query, h.host, () => {});
        assert.strictEqual(received, query);
        assert.strictEqual(result, response);
        assert.deepEqual(query, { StartIndex: 20, Limit: 20, SortBy: sort });
        h.frames();
        assert.equal(h.sentinel, null);
        assert.equal(h.pager.hidden, false);
    }
});
