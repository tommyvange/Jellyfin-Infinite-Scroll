#!/usr/bin/env node
/** Execute the transformed, shipped list controller used by category results.
 * Its bundled native ItemsContainer renderer performs the actual replacement,
 * append delegation, focus, and lifecycle flow. DOM/image effects and API I/O
 * are modeled; card, image, and blurhash-canvas node identity is observable.
 * Run tests/Transformations over the upstream list chunk before this script.
 * Fixtures stay in .research and are not redistributed with the plugin.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const fixtureDirectory = process.argv[2] ?? '.research/production';
const normalize = value => JSON.parse(JSON.stringify(value));
const identifier = '[A-Za-z_$][\\w$]*';

function createBoundary(config) {
    const frames = [];
    const zeroTimers = [];
    const observers = [];
    const windowEvents = new Map();
    const focusEvents = [];
    const nativeFocus = { tv: false, animationsStarted: 0, blocked: 0, queuedPositions: [], afterFocusTask: null };
    function scrollParent(element, axis) {
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            if (parent.getAttribute(`data-scroll-mode-${axis}`) === 'custom') return parent;
            const style = window.getComputedStyle(parent);
            const overflow = style[axis === 'x' ? 'overflowX' : 'overflowY'];
            const size = parent[axis === 'x' ? 'scrollWidth' : 'scrollHeight'];
            const client = parent[axis === 'x' ? 'clientWidth' : 'clientHeight'];
            if (overflow === 'scroll' || (overflow === 'auto' && size > client)) return parent;
        }
        return document.scrollingElement;
    }
    class Element {
        constructor(className = '', tagName = 'DIV') {
            this.tagName = tagName;
            this.className = className;
            this.children = [];
            this.parentNode = null;
            this.hidden = false;
            this.style = {};
            this.attributes = new Map();
            this.listeners = new Map();
            this.ownText = '';
            this.scrollTop = 0;
            this.scrollLeft = 0;
            this.clientHeight = 800;
            this.clientWidth = 1000;
            this.scrollHeight = 50000;
            this.scrollWidth = 2000;
            this.classList = {
                add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
                remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
                contains: name => this.className.split(/\s+/).includes(name)
            };
        }
        get isConnected() { return this === document.documentElement || this === document.body || Boolean(this.parentNode?.isConnected); }
        get parentElement() { return this.parentNode; }
        get firstChild() { return this.children[0] ?? null; }
        get firstElementChild() { return this.firstChild; }
        get childNodes() { return this.children; }
        get childElementCount() { return this.children.length; }
        get previousElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] ?? null; }
        get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
        set textContent(value) {
            this.children.forEach(child => { child.parentNode = null; });
            this.children = [];
            this.ownText = String(value);
        }
        get innerHTML() { return this.html ?? ''; }
        set innerHTML(value) {
            this.html = String(value);
            if (!this.classList.contains('itemsContainer') && !this.html.trim().startsWith('<')) return;
            if (this.classList.contains('itemsContainer')) this.replacements = (this.replacements ?? 0) + 1;
            if (this.contains(document.activeElement)) document.activeElement = document.body;
            this.children.forEach(child => { child.parentNode = null; });
            this.children = [];
            this.ownText = '';
            // The staging div used for append must have the same real child
            // structure as a normal native render, including loaded artwork.
            const stack = [this];
            let cardIndex = 0;
            for (const token of this.html.match(/<[^>]+>|[^<]+/g) ?? []) {
                if (token.startsWith('</')) {
                    if (stack.length > 1) stack.pop();
                } else if (token.startsWith('<')) {
                    const match = token.match(/^<([\w-]+)\b([^>]*)>/);
                    if (!match) continue;
                    const child = stack.at(-1).appendChild(new Element('', match[1].toUpperCase()));
                    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
                        child.setAttribute(attribute[1], attribute[2] ?? '');
                        if (attribute[1] === 'class') child.className = attribute[2];
                    }
                    child._top = child.hasAttribute('data-id') ? cardIndex++ * 250 : stack.at(-1)._top;
                    if (!['IMG', 'BR', 'INPUT', 'HR'].includes(child.tagName) && !token.endsWith('/>')) stack.push(child);
                } else {
                    stack.at(-1).ownText += token;
                }
            }
        }
        matches(selector) {
            return selector.split(',').some(part => {
                part = part.trim();
                if (part.startsWith('.')) return part.slice(1).split('.').every(name => this.className.split(/\s+/).includes(name));
                if (part === '[hidden]') return this.hidden;
                const attribute = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
                return attribute ? this.hasAttribute(attribute[1]) &&
                    (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]) : this.tagName.toLowerCase() === part.toLowerCase();
            });
        }
        querySelectorAll(selector) {
            return this.children.flatMap(child => [
                ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
            ]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
        closest(selector) {
            for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node;
            return null;
        }
        contains(element) {
            for (let node = element; node; node = node.parentNode) if (node === this) return true;
            return false;
        }
        focus(options = {}) {
            const changed = document.activeElement !== this;
            document.activeElement = this;
            focusEvents.push({ element: this, preventScroll: options.preventScroll === true });
            if (!options.preventScroll) {
                document.scrollingElement.scrollLeft = this._left ?? 0;
                document.scrollingElement.scrollTop = this._top ?? 0;
                view.scrollLeft = this._left ?? 0;
                view.scrollTop = this._top ?? 0;
            }
            if (nativeFocus.tv && changed) {
                // Jellyfin's TV scrollManager reacts to focus in a later task.
                // Its custom-ancestor early return precedes the 270ms RAF loop.
                zeroTimers.push(() => {
                    const xScroller = scrollParent(this, 'x');
                    const yScroller = scrollParent(this, 'y');
                    const customX = xScroller.getAttribute('data-scroll-mode-x') === 'custom';
                    const customY = yScroller.getAttribute('data-scroll-mode-y') === 'custom';
                    if ((xScroller === yScroller && (customX || customY)) || (customX && customY)) {
                        nativeFocus.blocked++;
                    } else {
                        nativeFocus.animationsStarted++;
                        const startX = xScroller.scrollLeft;
                        const startY = yScroller.scrollTop;
                        let frame = 0;
                        const animate = () => {
                            const progress = ++frame / 5;
                            xScroller.scrollLeft = startX + ((this._left ?? 0) - startX) * progress;
                            yScroller.scrollTop = startY + (Math.max(0, (this._top ?? 0) - 200) - startY) * progress;
                            nativeFocus.queuedPositions.push({ windowY: window.scrollY, ancestorY: view.scrollTop });
                            if (frame < 5) frames.push(animate);
                        };
                        frames.push(animate);
                    }
                    nativeFocus.afterFocusTask?.(this);
                });
            }
        }
        scrollTo(left, top) {
            if (typeof left === 'object') ({ left = this.scrollLeft, top = this.scrollTop } = left);
            this.scrollLeft = left;
            this.scrollTop = top;
        }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        hasAttribute(name) { return this.attributes.has(name); }
        removeAttribute(name) { this.attributes.delete(name); }
        getClientRects() { return this.isConnected && !this.closest('.hide, [hidden]') ? [{}] : []; }
        getBoundingClientRect() {
            const top = this.className.includes('sentinel') ? 2000 : (this._top ?? 0) - document.scrollingElement.scrollTop - view.scrollTop;
            return { top, left: 0, bottom: top + 250, right: 200, width: 200, height: 250 };
        }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        remove() {
            if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
            this.parentNode = null;
        }
        insertAdjacentElement(position, element) {
            assert.ok(['beforebegin', 'afterend'].includes(position));
            element.remove();
            this.parentNode.children.splice(this.parentNode.children.indexOf(this) + (position === 'afterend' ? 1 : 0), 0, element);
            element.parentNode = this.parentNode;
        }
        addEventListener(name, callback) {
            if (!this.listeners.has(name)) this.listeners.set(name, []);
            this.listeners.get(name).push(callback);
        }
        dispatch(name, detail = {}) { this.listeners.get(name)?.forEach(callback => callback({ detail, target: this })); }
        click() { this.dispatch('click'); }
    }
    const document = {
        body: new Element('', 'BODY'), head: new Element('', 'HEAD'), documentElement: new Element('', 'HTML'),
        createElement: name => new Element('', String(name).toUpperCase()), addEventListener() {},
        querySelectorAll: selector => document.body.querySelectorAll(selector),
        querySelector: selector => document.body.querySelector(selector)
    };
    document.documentElement.appendChild(document.body);
    document.scrollingElement = document.documentElement;
    document.activeElement = document.body;
    const view = document.body.appendChild(new Element('page'));
    const topPager = view.appendChild(new Element('paging'));
    const items = view.appendChild(new Element('itemsContainer vertical-wrap'));
    const bottomPager = view.appendChild(new Element('paging'));
    const pagers = [topPager, bottomPager];
    for (const pager of pagers) {
        const range = pager.appendChild(new Element('pagingRange'));
        range.textContent = '1 - 19 of 225';
        pager.appendChild(new Element('btnPreviousPage'));
        pager.appendChild(new Element('btnNextPage'));
    }
    const next = topPager.querySelector('.btnNextPage');
    view.appendChild(new Element('alphaPicker'));
    const actions = {};
    for (const action of ['Play', 'Queue', 'Shuffle']) actions[action.toLowerCase()] = view.appendChild(new Element(`btn${action}`));
    const window = {
        JellyfinInfiniteScrollConfig: config,
        document, location: { href: 'https://jellyfin.example/web/#/list?genreId=comedy&parentId=movies-library&serverId=server-1' },
        // A different globally selected server must not replace the native
        // category controller's authenticated ServerConnections client.
        ApiClient: { getCurrentUserId: () => 'other-server-user' },
        innerHeight: 800,
        addEventListener(name, callback) {
            if (!windowEvents.has(name)) windowEvents.set(name, []);
            windowEvents.get(name).push(callback);
        },
        get scrollX() { return document.scrollingElement.scrollLeft; },
        get scrollY() { return document.scrollingElement.scrollTop; },
        get pageXOffset() { return document.scrollingElement.scrollLeft; },
        get pageYOffset() { return document.scrollingElement.scrollTop; },
        scrollTo: (...args) => document.scrollingElement.scrollTo(...args),
        getComputedStyle: element => ({ overflow: element === view ? 'auto' : 'visible', overflowY: element === view ? 'auto' : 'visible', overflowX: element === view ? 'auto' : 'visible' }),
        requestAnimationFrame: callback => frames.push(callback),
        setTimeout(callback, delay) { if (delay === 0) zeroTimers.push(callback); return zeroTimers.length; },
        MutationObserver: class { observe() {} },
        IntersectionObserver: class {
            constructor(callback) { this.callback = callback; this.connected = true; observers.push(this); }
            observe() {} disconnect() { this.connected = false; }
        }
    };
    return {
        window, view, items, pager: topPager, pagers, next, actions, Element, focusEvents, nativeFocus,
        focusManager: {
            focus: element => element.focus({ preventScroll: nativeFocus.tv }),
            autoFocus: container => container.querySelector('.cardImageContainer')?.focus({ preventScroll: nativeFocus.tv })
        },
        input(type = 'wheel') { windowEvents.get(type)?.forEach(callback => callback({ type })); },
        navigate(href, event = 'hashchange') {
            window.location.href = href;
            windowEvents.get(event)?.forEach(callback => callback({}));
        },
        get sentinel() { return view.querySelector('.jellyfin-infinite-scroll-sentinel'); },
        get total() { return view.querySelector('.jellyfin-infinite-scroll-total'); },
        frames() {
            // Newly requested frames belong to a later paint. In particular, a
            // native smooth-scroll animation must outlast a zero-task restore.
            frames.splice(0).forEach(callback => callback());
        },
        intersect() {
            const observer = observers.filter(observer => observer.connected).at(-1);
            assert.ok(this.sentinel && observer, 'Actual category fetchData produced an observed sentinel');
            observer.callback([{ isIntersecting: true }]);
        },
        async settle() {
            await new Promise(resolve => setImmediate(resolve));
            this.frames();
            await new Promise(resolve => setImmediate(resolve));
            this.frames();
            let count = 0;
            while (zeroTimers.length) {
                assert.ok(++count < 30, 'Unexpected category timer loop');
                zeroTimers.shift()();
                this.frames();
            }
            while (frames.length) {
                assert.ok(++count < 60, 'Unexpected category animation loop');
                this.frames();
            }
        }
    };
}

function nativeFactory(source, context) {
    context.self = { webpackChunk: [] };
    vm.runInContext(source, context);
    const factories = context.self.webpackChunk.flatMap(chunk => Object.values(chunk[1]));
    const candidates = factories.filter(factory => {
        const text = factory.toString();
        return text.includes('.itemsContainer.fetchData=') && text.includes('queryRecursive') && text.includes('getSettingsKey');
    });
    assert.equal(candidates.length, 1, 'Expected one native generic-list controller module');
    const itemFactories = factories.filter(factory => factory.toString().includes('document.registerElement("emby-itemscontainer"'));
    assert.equal(itemFactories.length, 1, 'Actual native ItemsContainer module is present in the category chunk');
    return { list: candidates[0], items: itemFactories[0] };
}

function createController(source, runtimeSource, config = {}, { runtime = true, olderRuntime = false, olderAppendRuntime = false, item, params, sort, recordCount = 225 } = {}) {
    const boundary = createBoundary(config);
    const context = vm.createContext({
        window: boundary.window, document: boundary.window.document, DOMException, console,
        setTimeout: boundary.window.setTimeout, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        HTMLDivElement: function () {}
    });
    context.HTMLDivElement.prototype = boundary.Element.prototype;
    if (runtime) vm.runInContext(runtimeSource, context);
    if (olderRuntime) delete boundary.window.JellyfinInfiniteScroll.legacyList;
    if (olderAppendRuntime) delete boundary.window.JellyfinInfiniteScroll.appendList;
    const { list: factory, items: itemsFactory } = nativeFactory(source, context);
    const text = factory.toString();
    const requests = [];
    const itemRequests = [];
    const rendered = [];
    const lazyScopes = [];
    const afterRefreshCalls = [];
    const playback = [];
    const resumes = [];
    const records = Array.from({ length: recordCount }, (_unused, index) => ({ Id: `movie-${index}`, Name: `Movie ${index}` }));
    const state = {
        sort: sort ?? { sortBy: 'SortName', sortOrder: 'Ascending' },
        filters: { IsFavorite: true }, alphabet: 'A', total: recordCount,
        item: item === undefined ? { Id: 'comedy', Name: 'Comedy', Type: 'Genre', CollectionType: 'movies' } : item
    };
    const api = {
        getCurrentUserId: () => 'category-user',
        async getItem(userId, itemId) {
            itemRequests.push({ userId, itemId });
            return state.item;
        },
        async getItems(userId, query) {
            assert.strictEqual(this, api, 'Native API client method retains its receiver');
            return response('getItems', userId, query);
        },
        async getLiveTvPrograms(query) { return response('getLiveTvPrograms', query.UserId, query); },
        async getLiveTvRecommendedPrograms(query) { return response('getLiveTvRecommendedPrograms', query.UserId, query); },
        async getLiveTvRecordings(query) { return response('getLiveTvRecordings', query.UserId, query); },
        async getNextUpEpisodes(query) { return response('getNextUpEpisodes', query.UserId, query); }
    };
    function response(method, userId, query) {
        requests.push({ method, userId, query: normalize(query) });
        const offset = query.StartIndex ?? 0;
        const filteredRecords = Number.isFinite(state.total) ? records.slice(0, state.total) : records;
        const result = { Items: filteredRecords.slice(offset, offset + (query.Limit ?? records.length)), TotalRecordCount: state.total, StartIndex: offset };
        if (method === 'getItems' && state.nextItemsResponse) {
            const responseGate = state.nextItemsResponse;
            state.nextItemsResponse = null;
            return responseGate.then(() => result);
        }
        return result;
    }
    const imports = new Map();
    const requireName = text.match(new RegExp(`^function\\(${identifier},${identifier},(${identifier})\\)`))?.[1];
    assert.ok(requireName, 'Native module has its webpack require argument');
    const importedAliases = new Map();
    const importPattern = new RegExp(`(?:var\\s+|,)(${identifier})=(?:${requireName}\\((\\d+)\\)|\\((?:${requireName}\\(\\d+\\),)*${requireName}\\((\\d+)\\)\\))`, 'g');
    for (const match of text.matchAll(importPattern)) importedAliases.set(match[1], Number(match[2] ?? match[3]));

    function bindUsage(method, value) {
        const pattern = new RegExp(`(${identifier})\\.(${identifier})\\.${method}\\b`, 'g');
        const matches = [...text.matchAll(pattern)].filter(match => importedAliases.has(match[1]) && match[2] !== 'value');
        const bindings = new Map(matches.map(match => [`${match[1]}.${match[2]}`, match]));
        assert.equal(bindings.size, 1, `Locate native ${method} import (${[...bindings.keys()].join(', ')})`);
        const binding = [...bindings.values()][0];
        const id = importedAliases.get(binding[1]);
        if (!imports.has(id)) imports.set(id, {});
        imports.get(id)[binding[2]] = value;
    }
    bindUsage('getApiClient', { getApiClient(serverId) { assert.equal(serverId, 'server-1'); return api; } });
    bindUsage('translate', { translate: key => key });
    const renderCards = options => {
        rendered.push(options);
        return options.items.map(item => `<div class="card" data-id="${item.Id}"><a class="cardImageContainer cardContent itemAction"><img class="cardImage" data-src="${item.Id}.jpg"><canvas class="blurhash"></canvas></a></div>`).join('');
    };
    bindUsage('getCardsHtml', { getCardsHtml: renderCards });
    bindUsage('getListViewHtml', { getListViewHtml: renderCards });
    bindUsage('getQueryPagingHtml', { getQueryPagingHtml: query => JSON.stringify(query) });
    bindUsage('canQueue', {
        canQueue: () => true,
        play: options => playback.push({ action: 'play', options }),
        queue: options => playback.push({ action: 'queue', options }),
        shuffle: item => playback.push({ action: 'shuffle', item })
    });
    bindUsage('setTitle', { setTitle() {} });
    bindUsage('autoFocus', boundary.focusManager);
    bindUsage('show', { show() {}, hide() {} });
    bindUsage('addEventListener', { addEventListener() {}, removeEventListener() {} });
    bindUsage('Movies', new Proxy({}, { get: (_target, property) => String(property).toLowerCase() }));
    bindUsage('SortName', new Proxy({}, { get: (_target, property) => String(property) }));

    const sizeGetter = text.match(new RegExp(`(${identifier})\\.(${identifier})\\(\\)>0&&`));
    assert.ok(sizeGetter && importedAliases.has(sizeGetter[1]), 'Locate native user settings import');
    imports.set(importedAliases.get(sizeGetter[1]), new Proxy({}, {
        get: () => (...args) => {
            if (!args.length) return 19;
            if (args.length > 1) return state.sort;
            const key = String(args[0]);
            if (key.includes('-filter-')) {
                const value = state.filters[key.split('-filter-')[1]];
                return value === true ? 'true' : value === false ? 'false' : value;
            }
            return undefined;
        }
    }));
    // Multi-select is a side effect of native filtering. Keep it outside the
    // pagination adapter, while exercising the real filter-building code.
    const stopSelection = text.match(new RegExp(`this\\.hasFilters&&\\(0,(${identifier})\\.(${identifier})\\)\\(\\)`));
    assert.ok(stopSelection && importedAliases.has(stopSelection[1]), 'Locate native multi-select helper');
    imports.set(importedAliases.get(stopSelection[1]), { [stopSelection[2]]() {} });
    const alphaConstructor = text.match(new RegExp(`alphaPicker=new (${identifier})\\.(${identifier})\\(`));
    assert.ok(alphaConstructor && importedAliases.has(alphaConstructor[1]), 'Locate native alphabet picker');
    imports.set(importedAliases.get(alphaConstructor[1]), {
        [alphaConstructor[2]]: class {
            value() { return state.alphabet; }
            on() {} off() {} destroy() {}
        }
    });
    imports.set(76542, { Ay: { lazyChildren(scope) {
        const images = scope.querySelectorAll('.cardImage');
        lazyScopes.push({ scope, connected: scope.isConnected, images: images.slice() });
        for (const image of images) image.initializations = (image.initializations ?? 0) + 1;
    } } });
    const require = id => imports.get(id) ?? (id === 84069 ? { default: boundary.focusManager } : {});
    require.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
    require.d = (exports, getters) => {
        for (const [name, getter] of Object.entries(getters)) Object.defineProperty(exports, name, { get: getter, enumerable: true });
    };
    let itemsPrototype;
    boundary.window.document.registerElement = (name, options) => {
        assert.equal(name, 'emby-itemscontainer');
        itemsPrototype = options.prototype;
    };
    itemsFactory({ exports: {} }, {}, require);
    assert.equal(typeof itemsPrototype?.refreshItems, 'function', 'Actual native refreshItems was registered');
    Object.setPrototypeOf(boundary.items, itemsPrototype);
    const exports = {};
    factory({ exports }, exports, require);
    assert.equal(typeof exports.default, 'function', 'Native list constructor is exported');
    const nativeParams = params ?? { genreId: 'comedy', parentId: 'movies-library', serverId: 'server-1' };
    const instance = new exports.default(boundary.view, nativeParams);
    instance.currentItem = state.item;
    instance.alphaPicker = { value: () => state.alphabet, off() {}, destroy() {} };
    let result;
    const nativeGetItemsHtml = boundary.items.getItemsHtml;
    const nativeAfterRefresh = boundary.items.afterRefresh = function (value) {
        afterRefreshCalls.push({ receiver: this, args: Array.from(arguments) });
        result = value;
        return state.afterRefresh?.apply(this, arguments);
    };
    const nativeResume = boundary.items.resume;
    boundary.items.resume = function (options) {
        resumes.push(normalize(options));
        return nativeResume.call(this, options);
    };
    return { boundary, instance, state, requests, itemRequests, rendered, playback, records, resumes,
        lazyScopes, afterRefreshCalls, nativeGetItemsHtml, nativeAfterRefresh,
        get result() { return result; }, fetch: () => boundary.items.refreshItems() };
}

async function exerciseCategory(source, runtimeSource, batchSize) {
    const h = createController(source, runtimeSource, batchSize === 100 ? {} : { batchSize });
    await h.fetch();
    h.boundary.frames();
    const first = h.requests[0];
    assert.equal(first.method, 'getItems');
    assert.equal(first.userId, 'category-user');
    assert.equal(first.query.GenreIds, 'comedy');
    assert.equal(first.query.parentId, 'movies-library');
    assert.equal(first.query.IncludeItemTypes, 'Movie');
    assert.equal(first.query.Recursive, true);
    assert.equal(first.query.Filters, 'IsFavorite');
    assert.equal(first.query.SortBy, 'SortName');
    assert.equal(first.query.SortOrder, 'Ascending');
    assert.equal(first.query.NameStartsWith, 'A');
    assert.equal(first.query.StartIndex, 0);
    assert.equal(first.query.Limit, batchSize);
    assert.equal(h.result.Items.length, batchSize);
    assert.equal(h.boundary.pager.hidden, true);
    h.boundary.intersect();
    await h.boundary.settle();
    assert.deepEqual(h.requests.map(request => request.query.StartIndex), [0, batchSize]);
    assert.ok(h.requests.every(request => request.query.Limit === batchSize && request.userId === 'category-user'));
    assert.equal(h.result.Items.length, batchSize * 2);
    assert.deepEqual(Array.from(h.result.Items, item => item.Id), h.records.slice(0, batchSize * 2).map(item => item.Id));
    assert.equal(h.rendered.at(-1).items.length, batchSize, 'Native card renderer receives only the new suffix');
    assert.equal(h.boundary.items.replacements, 1, 'The initial native render is not replaced during append');
    assert.equal(h.rendered.at(-1).overlayMoreButton, true, 'Native card actions survive');

    h.state.filters = { IsUnplayed: true, IsHD: true };
    await h.fetch();
    assert.equal(h.requests.at(-1).query.StartIndex, 0);
    assert.equal(h.requests.at(-1).query.Filters, 'IsUnplayed');
    assert.equal(h.requests.at(-1).query.IsHD, true);
    assert.equal(h.result.Items.length, batchSize, 'Filter changes reset accumulated cards');
    h.state.sort = { sortBy: 'DateCreated,SortName', sortOrder: 'Descending' };
    await h.fetch();
    assert.equal(h.requests.at(-1).query.StartIndex, 0);
    assert.equal(h.requests.at(-1).query.SortBy, 'DateCreated,SortName');
    assert.equal(h.requests.at(-1).query.SortOrder, 'Descending');
    h.state.alphabet = '#';
    await h.fetch();
    assert.equal(h.requests.at(-1).query.StartIndex, 0);
    assert.equal(h.requests.at(-1).query.NameLessThan, 'A');
    assert.equal(h.requests.at(-1).query.NameStartsWith, undefined);
    h.state.alphabet = 'B';
    await h.fetch();
    assert.equal(h.requests.at(-1).query.StartIndex, 0);
    assert.equal(h.requests.at(-1).query.NameStartsWith, 'B');
    console.log(`PASS: actual Movies > Categories > Comedy controller, batch ${batchSize}, native category/parent/auth/filter/sort/alpha queries, suffix-only append, and hidden pagination.`);
}

async function exerciseFallback(source, runtimeSource, config, options, label) {
    const h = createController(source, runtimeSource, config, options);
    await h.fetch();
    h.boundary.frames();
    assert.equal(h.requests[0].query.StartIndex, 0);
    assert.equal(h.requests[0].query.Limit, 19);
    assert.equal(h.result.__jellyfinInfiniteScroll, undefined);
    assert.equal(h.boundary.sentinel, null);
    assert.equal(h.boundary.pager.hidden, false);
    assert.equal(h.boundary.total, null, 'Native pagination does not get a separate infinite-scroll count');
    assert.ok(h.boundary.pagers.every(pager => !pager.hidden));
    for (const pager of h.boundary.pagers) {
        const paging = JSON.parse(pager.innerHTML);
        assert.equal(paging.startIndex, 0);
        assert.equal(paging.limit, 19);
        assert.equal(paging.totalRecordCount, 225);
    }
    h.boundary.next.click();
    await h.boundary.settle();
    assert.equal(h.requests.at(-1).query.StartIndex, 19);
    assert.equal(h.requests.at(-1).query.Limit, 19);
    assert.equal(h.result.Items.length, 19);
    console.log(`PASS: ${label} retains the actual native next-page flow and page size.`);
}

async function exerciseOtherCategories(source, runtimeSource) {
    for (const [Type, field, expectedTypes, type] of [
        ['MusicGenre', 'GenreIds', 'MusicAlbum', undefined],
        ['Studio', 'StudioIds', 'Movie', undefined],
        ['Person', 'PersonIds', 'Movie', 'Movie']
    ]) {
        const h = createController(source, runtimeSource, { batchSize: 7 }, {
            item: { Id: 'category-1', Name: 'Category', Type, CollectionType: Type === 'Studio' ? 'movies' : undefined },
            params: { serverId: 'server-1', parentId: 'movies-library', type }
        });
        await h.fetch();
        h.boundary.frames();
        assert.equal(h.requests[0].query[field], 'category-1');
        assert.equal(h.requests[0].query.IncludeItemTypes, expectedTypes);
        assert.equal(h.requests[0].query.Limit, 7);
        assert.equal(h.boundary.pager.hidden, true);
    }
    for (const type of ['Programs', 'Recordings', 'nextup']) {
        const h = createController(source, runtimeSource, { batchSize: 7 }, {
            params: { serverId: 'server-1', type }
        });
        await h.fetch();
        h.boundary.frames();
        assert.equal(h.requests[0].method, {
            Programs: 'getLiveTvPrograms', Recordings: 'getLiveTvRecordings', nextup: 'getNextUpEpisodes'
        }[type]);
        assert.equal(h.requests[0].query.Limit, 19, `${type} keeps native paging`);
        assert.equal(h.result.__jellyfinInfiniteScroll, undefined);
        assert.equal(h.boundary.sentinel, null);
    }
    console.log('PASS: native MusicGenre/Studio/Person category filters remain intact; live TV and next-up modes retain native behavior.');
}

async function exercisePlayback(source, runtimeSource) {
    const h = createController(source, runtimeSource, { batchSize: 7 });
    h.boundary.view.dispatch('viewshow', { isRestored: false });
    await h.boundary.settle();
    assert.deepEqual(h.itemRequests, [{ userId: 'category-user', itemId: 'comedy' }], 'Native route resolves the authenticated genre');
    assert.equal(h.result.Items.length, 7);
    for (const action of ['play', 'queue', 'shuffle']) {
        h.boundary.actions[action].click();
        await h.boundary.settle();
        assert.equal(h.requests.at(-1).query.StartIndex, 0);
        assert.equal(h.requests.at(-1).query.Limit, 300, `${action} retains its native request limit`);
        assert.equal(h.playback.at(-1).options.items.length, 225);
    }
    assert.equal(h.requests.at(-1).query.SortBy, 'Random', 'Native shuffle keeps its random query');
    h.boundary.intersect();
    await h.boundary.settle();
    assert.equal(h.requests.at(-1).query.StartIndex, 7, 'Playback requests do not advance the display offset');
    assert.equal(h.requests.at(-1).query.Limit, 7);
    assert.equal(h.result.Items.length, 14);
    console.log('PASS: actual native play, queue, and shuffle requests keep their 300-item limits and do not change the infinite-scroll session.');
}

async function exerciseRestoredView(source, runtimeSource) {
    const h = createController(source, runtimeSource, { batchSize: 7 });
    const categoryRoute = h.boundary.window.location.href;
    h.boundary.view.dispatch('viewshow', { isRestored: false });
    await h.boundary.settle();
    h.boundary.intersect();
    await h.boundary.settle();
    assert.equal(h.result.Items.length, 14);
    const cachedResult = h.result;
    h.boundary.view.dispatch('viewhide');
    h.boundary.navigate('https://jellyfin.example/web/#/details?id=movie-1');
    assert.equal(h.boundary.sentinel, null);
    assert.equal(h.boundary.total, null);
    h.boundary.navigate(categoryRoute, 'popstate');
    h.boundary.view.dispatch('viewshow', { isRestored: true });
    await h.boundary.settle();
    assert.deepEqual(h.resumes.at(-1), { refresh: false }, 'Actual restored view requests native cached content');
    assert.equal(h.requests.length, 2, 'Native resume(false) does not fetch the first page again');
    assert.strictEqual(h.result, cachedResult, 'Already rendered accumulated cards survive returning from details');
    assert.ok(h.boundary.sentinel, 'Restored cached category view reattaches infinite scrolling');
    assert.equal(h.boundary.total.textContent, '225', 'Cached restoration rebuilds the full header count');
    assert.equal(h.boundary.pager.hidden, true);
    h.boundary.intersect();
    await h.boundary.settle();
    assert.deepEqual(h.requests.map(request => request.query.StartIndex), [0, 7, 14]);
    assert.equal(h.result.Items.length, 21);
    h.boundary.view.dispatch('viewdestroy');
    assert.equal(h.boundary.sentinel, null);
    assert.equal(h.boundary.total, null);
    assert.equal(h.boundary.pager.hidden, false);
    console.log('PASS: actual native restored viewshow + resume(false) keeps cached cards and resumes loading at the next offset; destroying the view removes its sentinel.');
}

async function exerciseAbandonedFinalBatch(source, runtimeSource) {
    const h = createController(source, runtimeSource, {}, { recordCount: 150 });
    const categoryRoute = h.boundary.window.location.href;
    h.boundary.view.dispatch('viewshow', { isRestored: false });
    await h.boundary.settle();
    assert.equal(h.result.Items.length, 100);
    const cachedNodes = artworkSnapshot(h);
    let releaseResponse;
    h.state.nextItemsResponse = new Promise(resolve => { releaseResponse = resolve; });
    h.boundary.intersect();
    await h.boundary.settle();
    assert.equal(h.requests.at(-1).query.StartIndex, 100);
    h.boundary.view.dispatch('viewhide');
    h.boundary.navigate('https://jellyfin.example/web/#/details?id=movie-1');
    releaseResponse();
    await h.boundary.settle();
    assert.equal(h.result.Items.length, 100, 'Native cached cards were not rendered after leaving the category');
    h.boundary.navigate(categoryRoute, 'popstate');
    h.boundary.view.dispatch('viewshow', { isRestored: true });
    await h.boundary.settle();
    assert.equal(h.requests.length, 2, 'Restoring cached native cards does not refetch');
    assertArtworkPreserved(h, cachedNodes, 'Returning from details preserves the unexhausted cached DOM');
    assert.doesNotMatch(h.boundary.sentinel.textContent, /All items loaded/);
    h.boundary.intersect();
    await h.boundary.settle();
    assert.deepEqual(h.requests.map(request => request.query.StartIndex), [0, 100, 100]);
    assert.deepEqual(Array.from(h.result.Items, item => item.Id), h.records.map(item => item.Id));
    assert.equal(h.rendered.at(-1).items.length, 50);
    assertArtworkPreserved(h, cachedNodes, 'Retrying the unrendered final offset appends to cached DOM');
    assert.equal(h.boundary.sentinel.textContent, 'All items loaded.');
    console.log('PASS: a final batch resolved while away cannot exhaust cached category cards; returning retries the unrendered offset and renders all 150 cards once.');
}

async function exerciseCategoryCount(source, runtimeSource) {
    const h = createController(source, runtimeSource, {}, { recordCount: 731 });
    await h.fetch();
    h.boundary.frames();
    assert.equal(h.result.Items.length, 100);
    assert.equal(h.boundary.total.textContent, '731', 'Header displays full category total while only one batch is loaded');
    assert.equal(h.boundary.total.getAttribute('aria-live'), 'polite');
    assert.ok(h.boundary.total.classList.contains('MuiChip-root'), 'Category count exposes the native library Chip theme class');
    assert.ok(h.boundary.total.classList.contains('MuiChip-filled'));
    assert.ok(h.boundary.total.classList.contains('MuiChip-sizeMedium'));
    assert.ok(h.boundary.total.classList.contains('MuiChip-colorDefault'));
    const label = h.boundary.total.querySelector('.MuiChip-label.MuiChip-labelMedium');
    assert.ok(label, 'Category count preserves the native Chip label structure');
    assert.equal(label.textContent, '731');
    assert.equal(h.boundary.view.querySelectorAll('.jellyfin-infinite-scroll-total').length, 1);
    assert.strictEqual(h.boundary.pager.previousElementSibling, h.boundary.total, 'Header count occupies the first native pager position');
    for (const pager of h.boundary.pagers) {
        assert.equal(pager.hidden, true);
        assert.equal(pager.querySelector('.pagingRange').getClientRects().length, 0);
        assert.equal(pager.querySelector('.btnNextPage').getClientRects().length, 0);
        assert.equal(pager.querySelector('.btnPreviousPage').getClientRects().length, 0);
    }
    h.boundary.intersect();
    await h.boundary.settle();
    assert.equal(h.result.Items.length, 200);
    assert.equal(h.boundary.total.textContent, '731');
    h.state.filters = { IsUnplayed: true };
    h.state.total = 23;
    await h.fetch();
    h.boundary.frames();
    assert.equal(h.result.Items.length, 23);
    assert.equal(h.boundary.total.textContent, '23', 'Native filtered total updates the header');
    h.state.filters = { IsPlayed: true };
    h.state.total = 0;
    await h.fetch();
    h.boundary.frames();
    assert.equal(h.boundary.total.textContent, '0');
    assert.ok(h.boundary.total.getClientRects().length > 0);
    h.state.filters = {};
    h.state.total = undefined;
    await h.fetch();
    h.boundary.frames();
    assert.equal(h.result.Items.length, 100);
    assert.equal(h.boundary.total, null, 'Unknown API totals never display the loaded count');
    h.state.total = 731;
    await h.fetch();
    h.boundary.frames();
    assert.equal(h.boundary.total.textContent, '731');
    h.state.sort = { sortBy: 'Random', sortOrder: 'Ascending' };
    await h.fetch();
    h.boundary.frames();
    assert.equal(h.boundary.total, null);
    assert.ok(h.boundary.pagers.every(pager => !pager.hidden));
    console.log('PASS: category header shows full total 731 above 100 loaded cards; filters, zero/unknown totals, both native pagers, and random-sort cleanup behave correctly.');
}

async function exerciseNativeRendererControl(source, runtimeSource) {
    const h = createController(source, runtimeSource, { enabled: false });
    await h.fetch();
    const originalLink = h.boundary.items.querySelectorAll('.cardImageContainer')[10];
    assert.ok(originalLink, 'Real native onDataFetched rendered focusable card links');
    assert.equal(originalLink.getAttribute('data-id'), null, 'Native image links do not carry the outer card ID');
    h.boundary.window.document.activeElement = originalLink;
    h.boundary.window.scrollTo(17, 2100);
    h.boundary.view.scrollTo(11, 1400);
    await h.fetch();
    assert.equal(originalLink.isConnected, false, 'Native innerHTML replacement removes the focused link');
    assert.equal(h.boundary.items.replacements, 2);
    assert.equal(h.boundary.window.scrollX, 0);
    assert.equal(h.boundary.window.scrollY, 0, 'Native onDataFetched autofocus moves a nonzero document viewport');
    assert.equal(h.boundary.view.scrollLeft, 0);
    assert.equal(h.boundary.view.scrollTop, 0, 'Native autofocus also moves the scrollable ancestor');
    assert.strictEqual(h.boundary.window.document.activeElement, h.boundary.items.querySelector('.cardImageContainer'));
    assert.equal(h.boundary.focusEvents.at(-1).preventScroll, false);
    console.log('PASS: real native ItemsContainer control reproduces the focus-driven viewport jump after replacing a focused card image link.');
}

function viewport(h) {
    return {
        windowX: h.boundary.window.scrollX, windowY: h.boundary.window.scrollY,
        ancestorX: h.boundary.view.scrollLeft, ancestorY: h.boundary.view.scrollTop
    };
}

function moveViewport(h, position) {
    h.boundary.window.scrollTo(position.windowX, position.windowY);
    h.boundary.view.scrollTo(position.ancestorX, position.ancestorY);
}

function focusCard(h, index) {
    const link = h.boundary.items.querySelectorAll('.cardImageContainer')[index];
    assert.ok(link, `Rendered card ${index} has a native-style focusable image link`);
    h.boundary.window.document.activeElement = link;
    return link.closest('[data-id]').getAttribute('data-id');
}

function assertFocusedCard(h, id) {
    assert.equal(h.boundary.window.document.activeElement.closest('[data-id]')?.getAttribute('data-id'), id);
    assert.ok(h.boundary.window.document.activeElement.isConnected);
}

function artworkSnapshot(h) {
    return h.boundary.items.querySelectorAll('.card').map(card => ({
        card,
        link: card.querySelector('.cardImageContainer'),
        image: card.querySelector('.cardImage'),
        canvas: card.querySelector('.blurhash'),
        initializations: card.querySelector('.cardImage').initializations
    }));
}

function assertArtworkPreserved(h, snapshot, label) {
    const cards = h.boundary.items.querySelectorAll('.card');
    for (const [index, previous] of snapshot.entries()) {
        assert.strictEqual(cards[index], previous.card, `${label}: existing card ${index} is retained`);
        assert.strictEqual(cards[index].querySelector('.cardImageContainer'), previous.link);
        assert.strictEqual(cards[index].querySelector('.cardImage'), previous.image);
        assert.strictEqual(cards[index].querySelector('.blurhash'), previous.canvas);
        assert.equal(previous.image.initializations, previous.initializations, `${label}: old artwork is not initialized again`);
        assert.ok(previous.link.isConnected);
    }
}

async function exerciseAppendViewport(source, runtimeSource) {
    const h = createController(source, runtimeSource);
    moveViewport(h, { windowX: 7, windowY: 1200, ancestorX: 11, ancestorY: 1600 });
    h.boundary.view.dispatch('viewshow', { isRestored: false });
    await h.boundary.settle();
    assert.equal(h.boundary.window.scrollY, 0, 'Initial native viewshow retains its autofocus behavior');
    assert.equal(h.boundary.view.scrollTop, 0);
    const focusedId = focusCard(h, 25);
    const originalLink = h.boundary.window.document.activeElement;
    const originalArtwork = artworkSnapshot(h);
    const initialLazyScopes = h.lazyScopes.length;
    assert.ok(originalArtwork.every(item => item.initializations === 1), 'Initial native lazy initialization runs once');
    moveViewport(h, { windowX: 17, windowY: 1200, ancestorX: 11, ancestorY: 1450 });
    let releaseResponse;
    h.state.nextItemsResponse = new Promise(resolve => { releaseResponse = resolve; });
    h.boundary.intersect();
    await h.boundary.settle();
    const latest = { windowX: 23, windowY: 1840, ancestorX: 31, ancestorY: 2480 };
    moveViewport(h, latest);
    const focusCount = h.boundary.focusEvents.length;
    releaseResponse();
    await h.boundary.settle();
    assert.equal(h.result.Items.length, 200);
    assert.deepEqual(viewport(h), latest, 'Append preserves the latest viewport after scrolling during the request');
    assertFocusedCard(h, focusedId);
    assert.strictEqual(h.boundary.window.document.activeElement, originalLink, 'The original focused link survives append');
    assert.equal(h.boundary.focusEvents.length, focusCount, 'Appending retained DOM does not perform any focus operation');
    assertArtworkPreserved(h, originalArtwork, 'Successful append');
    assert.equal(h.boundary.items.replacements, 1);
    assert.equal(h.rendered.at(-1).items.length, 100);
    assert.deepEqual(Array.from(h.rendered.at(-1).items, item => item.Id), h.records.slice(100, 200).map(item => item.Id));
    assert.equal(h.lazyScopes.length, initialLazyScopes + 1, 'Only new artwork gets one lazy initialization pass');
    const newScope = h.lazyScopes.at(-1);
    assert.notStrictEqual(newScope.scope, h.boundary.items, 'Lazy initialization is scoped to the staging element');
    assert.equal(newScope.connected, false, 'Only the detached new cards are initialized');
    assert.equal(newScope.images.length, 100);
    assert.ok(newScope.images.every(image => image.initializations === 1 && image.isConnected));

    const failedFocusId = focusCard(h, 35);
    const beforeFailure = artworkSnapshot(h);
    const rendersBeforeFailure = h.rendered.length;
    const lazyBeforeFailure = h.lazyScopes.length;
    let rejectResponse;
    h.state.nextItemsResponse = new Promise((_resolve, reject) => { rejectResponse = reject; });
    h.boundary.intersect();
    await h.boundary.settle();
    const afterFailure = { windowX: 39, windowY: 3500, ancestorX: 52, ancestorY: 4600 };
    moveViewport(h, afterFailure);
    rejectResponse(new Error('Append connection failed'));
    await h.boundary.settle();
    assert.equal(h.result.Items.length, 200);
    assert.deepEqual(viewport(h), afterFailure, 'Failed append leaves the current viewport unchanged');
    assertFocusedCard(h, failedFocusId);
    assertArtworkPreserved(h, beforeFailure, 'Failed append');
    assert.equal(h.boundary.items.replacements, 1);
    assert.equal(h.rendered.length, rendersBeforeFailure, 'A failed append does not regenerate existing card HTML');
    assert.equal(h.lazyScopes.length, lazyBeforeFailure, 'A failed append does not reinitialize any artwork');
    assert.match(h.boundary.sentinel.textContent, /Could not load more items/);
    const retryPosition = { windowX: 45, windowY: 4100, ancestorX: 63, ancestorY: 5100 };
    moveViewport(h, retryPosition);
    h.boundary.sentinel.querySelector('BUTTON').click();
    await h.boundary.settle();
    assert.deepEqual(h.requests.map(request => request.query.StartIndex), [0, 100, 200, 200]);
    assert.equal(h.result.Items.length, 225);
    assert.deepEqual(viewport(h), retryPosition, 'Explicit retry preserves the viewport');
    assertFocusedCard(h, failedFocusId);
    assertArtworkPreserved(h, beforeFailure, 'Retried append');
    assert.equal(h.rendered.at(-1).items.length, 25);
    assert.equal(h.lazyScopes.at(-1).images.length, 25);
    assert.equal(h.boundary.items.replacements, 1);
    assert.equal(h.afterRefreshCalls.length, 4, 'Native afterRefresh lifecycle still runs on initial, append, failure, and retry');
    assert.ok(h.afterRefreshCalls.every(call => call.receiver === h.boundary.items && call.args.length === 1));

    h.state.filters = { IsUnplayed: true };
    await h.fetch();
    await h.boundary.settle();
    assert.equal(h.result.Items.length, 100);
    assert.equal(h.boundary.items.replacements, 2, 'A filter reset still uses the native full replacement');
    assert.ok(beforeFailure.every(item => !item.card.isConnected), 'Filter reset discards cards from the previous query');
    assert.equal(h.rendered.at(-1).items.length, 100);
    assert.equal(h.boundary.window.scrollY, 0, 'Normal filter refresh keeps native focus/scroll behavior');
    assert.equal(h.boundary.view.scrollTop, 0);
    const outsideFocus = h.boundary.actions.play;
    h.boundary.window.document.activeElement = outsideFocus;
    const outsidePosition = { windowX: 19, windowY: 2120, ancestorX: 28, ancestorY: 3100 };
    moveViewport(h, outsidePosition);
    h.boundary.intersect();
    await h.boundary.settle();
    assert.deepEqual(viewport(h), outsidePosition);
    assert.strictEqual(h.boundary.window.document.activeElement, outsideFocus, 'Appending does not steal focus from outside the cards');
    console.log('PASS: actual native renderer retains card/link/image/canvas identity and existing artwork initialization during append, failure, and retry; only new suffix cards are rendered and initialized.');
}

async function exerciseAppendNavigation(source, runtimeSource) {
    for (const cancellation of ['navigation', 'destroy']) {
        const h = createController(source, runtimeSource);
        h.boundary.view.dispatch('viewshow', { isRestored: false });
        await h.boundary.settle();
        focusCard(h, 25);
        const beforeAppend = { windowX: 13, windowY: 2600, ancestorX: 22, ancestorY: 3700 };
        moveViewport(h, beforeAppend);
        h.boundary.nativeFocus.tv = true;
        const destination = { windowX: 5, windowY: 543, ancestorX: 7, ancestorY: 654 };
        h.state.afterRefresh = result => {
            if (result.Items.length > 100) {
                if (cancellation === 'navigation') h.boundary.navigate('https://jellyfin.example/web/#/details?id=movie-1');
                else h.boundary.view.dispatch('viewdestroy');
                h.boundary.window.document.activeElement = h.boundary.window.document.body;
                moveViewport(h, destination);
            }
        };
        h.boundary.intersect();
        await h.boundary.settle();
        assert.equal(h.result.Items.length, 200);
        assert.deepEqual(viewport(h), destination, `${cancellation} inside native afterRefresh prevents restoring the previous page viewport`);
        assert.strictEqual(h.boundary.window.document.activeElement, h.boundary.window.document.body);
        assert.equal(h.boundary.nativeFocus.animationsStarted, 0, 'Append does not enqueue native TV focus through navigation/destruction');
        assert.equal(h.boundary.nativeFocus.blocked, 0, 'Append needs no temporary focus suppression');
        assert.equal(h.boundary.items.getAttribute('data-scroll-mode-x'), null);
        assert.equal(h.boundary.items.getAttribute('data-scroll-mode-y'), null);
    }
    console.log('PASS: native afterRefresh runs for append and can navigate/destroy without any later scroll or focus work.');
}

async function exerciseQueuedFocusViewport(source, runtimeSource) {
    const h = createController(source, runtimeSource);
    h.boundary.nativeFocus.tv = true;
    moveViewport(h, { windowX: 12, windowY: 1300, ancestorX: 24, ancestorY: 2400 });
    h.boundary.view.dispatch('viewshow', { isRestored: false });
    await h.boundary.settle();
    assert.ok(h.boundary.nativeFocus.animationsStarted > 0, 'Initial native TV focus can start its smooth animation');
    const initialAnimations = h.boundary.nativeFocus.animationsStarted;
    const focusedId = focusCard(h, 25);
    const originalLink = h.boundary.window.document.activeElement;
    const originalArtwork = artworkSnapshot(h);
    const current = { windowX: 21, windowY: 1930, ancestorX: 32, ancestorY: 2850 };
    moveViewport(h, current);
    h.boundary.items.setAttribute('data-scroll-mode-x', 'center');
    h.boundary.items.setAttribute('data-scroll-mode-y', 'nearest');
    let refreshedAfterAppend = false;
    h.state.afterRefresh = result => {
        if (result.Items.length > 100) {
            refreshedAfterAppend = true;
            assert.equal(h.boundary.items.getAttribute('data-scroll-mode-x'), 'center');
            assert.equal(h.boundary.items.getAttribute('data-scroll-mode-y'), 'nearest');
        }
    };
    h.boundary.intersect();
    await h.boundary.settle();
    assert.ok(refreshedAfterAppend);
    assert.equal(h.boundary.nativeFocus.blocked, 0, 'Append does not need custom scroll-mode markers');
    assert.equal(h.boundary.nativeFocus.animationsStarted, initialAnimations, 'Append never starts a native smooth-scroll animation');
    assert.deepEqual(viewport(h), current);
    assertFocusedCard(h, focusedId);
    assert.strictEqual(h.boundary.window.document.activeElement, originalLink);
    assertArtworkPreserved(h, originalArtwork, 'TV append');
    assert.equal(h.boundary.items.getAttribute('data-scroll-mode-x'), 'center');
    assert.equal(h.boundary.items.getAttribute('data-scroll-mode-y'), 'nearest');
    h.state.filters = { IsUnplayed: true };
    await h.fetch();
    await h.boundary.settle();
    assert.ok(h.boundary.nativeFocus.animationsStarted > initialAnimations, 'Normal filter refresh still permits native smooth scrolling');
    console.log('PASS: retaining original category DOM avoids TV focus/smooth scrolling entirely and leaves existing scroll-mode attributes untouched; initial/filter focus remains native.');
}

async function exerciseAppendCompatibility(source, runtimeSource) {
    const h = createController(source, runtimeSource, {}, { olderAppendRuntime: true });
    await h.fetch();
    h.boundary.frames();
    const previous = artworkSnapshot(h);
    h.boundary.intersect();
    await h.boundary.settle();
    assert.deepEqual(h.requests.map(request => request.query.StartIndex), [0, 100]);
    assert.equal(h.result.Items.length, 200);
    assert.equal(h.boundary.items.replacements, 2, 'A previously loaded runtime without appendList still uses native full rendering');
    assert.equal(h.rendered.at(-1).items.length, 200);
    assert.ok(previous.every(item => !item.card.isConnected));
    assert.strictEqual(h.lazyScopes.at(-1).scope, h.boundary.items);
    assert.equal(h.afterRefreshCalls.length, 2, 'Fallback preserves native refresh lifecycle');
    console.log('PASS: an older runtime without appendList retains a working native full-render fallback and lifecycle.');
}

async function exerciseAppendPrefixGuard(source, runtimeSource) {
    const h = createController(source, runtimeSource);
    await h.fetch();
    h.boundary.frames();
    const previous = artworkSnapshot(h);
    const append = h.boundary.window.JellyfinInfiniteScroll.appendList;
    let accepted;
    h.boundary.window.JellyfinInfiniteScroll.appendList = function (container, result, initialize) {
        if (result.Items.length > 100) {
            // Same item ID, different item reference: do not silently preserve
            // a card from an incompatible retained prefix.
            result.Items[0] = { ...result.Items[0], Name: 'Updated first card' };
            accepted = append(container, result, initialize);
            return accepted;
        }
        return append(container, result, initialize);
    };
    h.boundary.intersect();
    await h.boundary.settle();
    assert.equal(accepted, false, 'A changed prefix is rejected at the native render boundary');
    assert.equal(h.boundary.items.replacements, 2);
    assert.equal(h.rendered.at(-1).items.length, 200, 'Rejected append receives the complete native result');
    assert.ok(previous.every(item => !item.card.isConnected));
    assert.equal(h.result.Items[0].Name, 'Updated first card');
    assert.strictEqual(h.lazyScopes.at(-1).scope, h.boundary.items);
    console.log('PASS: a different retained item reference falls back to complete native rendering rather than leaving stale cards.');
}

async function exerciseRendererDisposal(source, runtimeSource) {
    const h = createController(source, runtimeSource);
    await h.fetch();
    h.boundary.frames();
    assert.notStrictEqual(h.boundary.items.getItemsHtml, h.nativeGetItemsHtml, 'Live category binding observes native full renders');
    assert.notStrictEqual(h.boundary.items.afterRefresh, h.nativeAfterRefresh);
    h.boundary.intersect();
    await h.boundary.settle();
    assert.equal(h.afterRefreshCalls.length, 2);
    assert.ok(h.afterRefreshCalls.every(call => call.receiver === h.boundary.items && call.args.length === 1));
    h.boundary.view.dispatch('viewdestroy');
    assert.strictEqual(h.boundary.items.getItemsHtml, h.nativeGetItemsHtml, 'Destroy restores the original native renderer');
    assert.strictEqual(h.boundary.items.afterRefresh, h.nativeAfterRefresh, 'Destroy restores the original refresh callback');
    assert.equal(h.boundary.window.JellyfinInfiniteScroll.appendList(h.boundary.items, h.result, () => assert.fail('Disposed binding initialized artwork')), false);

    const owned = createController(source, runtimeSource);
    await owned.fetch();
    owned.boundary.frames();
    const newerRenderer = () => '';
    const newerRefresh = () => {};
    owned.boundary.items.getItemsHtml = newerRenderer;
    owned.boundary.items.afterRefresh = newerRefresh;
    owned.boundary.view.dispatch('viewdestroy');
    assert.strictEqual(owned.boundary.items.getItemsHtml, newerRenderer, 'Disposal respects a newer renderer owner');
    assert.strictEqual(owned.boundary.items.afterRefresh, newerRefresh, 'Disposal respects a newer callback owner');
    console.log('PASS: append preserves native afterRefresh receiver/arguments and destruction releases only callbacks owned by its binding.');
}

async function main() {
    const files = await readdir(fixtureDirectory);
    const candidates = [];
    for (const name of files.filter(name => name.endsWith('.patched.js'))) {
        const source = await readFile(path.join(fixtureDirectory, name), 'utf8');
        if (source.includes('.itemsContainer.fetchData=') && source.includes('queryRecursive') && source.includes('getSettingsKey')) candidates.push({ name, source });
    }
    assert.equal(candidates.length, 1, 'Generate exactly one patched generic-list category fixture first');
    const [{ name, source }] = candidates;
    assert.ok(source.includes('JellyfinInfiniteScroll.legacyList'), 'Native category display request was transformed');
    assert.ok(source.includes('JellyfinInfiniteScroll.appendList'), 'Native category renderer delegates guarded appends');
    const runtimeSource = await readFile('src/Jellyfin.Plugin.InfiniteScroll/Web/infinite-scroll.js', 'utf8');
    for (const batchSize of [100, 7]) await exerciseCategory(source, runtimeSource, batchSize);
    await exerciseFallback(source, runtimeSource, { enabled: false }, {}, 'Disabled category extension');
    await exerciseFallback(source, runtimeSource, {}, { runtime: false }, 'Unavailable category extension');
    await exerciseFallback(source, runtimeSource, {}, { olderRuntime: true }, 'Already loaded older extension runtime');
    await exerciseFallback(source, runtimeSource, {}, { sort: { sortBy: 'Random', sortOrder: 'Ascending' } }, 'Random category sorting');
    await exerciseFallback(source, runtimeSource, {}, { item: { Id: 'folder-1', Type: 'Folder' } }, 'Non-category folder list');
    await exerciseOtherCategories(source, runtimeSource);
    await exercisePlayback(source, runtimeSource);
    await exerciseRestoredView(source, runtimeSource);
    await exerciseAbandonedFinalBatch(source, runtimeSource);
    await exerciseCategoryCount(source, runtimeSource);
    await exerciseNativeRendererControl(source, runtimeSource);
    await exerciseAppendViewport(source, runtimeSource);
    await exerciseAppendNavigation(source, runtimeSource);
    await exerciseQueuedFocusViewport(source, runtimeSource);
    await exerciseAppendCompatibility(source, runtimeSource);
    await exerciseAppendPrefixGuard(source, runtimeSource);
    await exerciseRendererDisposal(source, runtimeSource);
    console.log(`PASS: production category bridge ${name}.`);
}

main().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
