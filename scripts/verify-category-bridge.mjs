#!/usr/bin/env node
/** Execute the transformed, shipped list controller used by category results.
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
    const observers = [];
    class Element {
        constructor(className = '') {
            this.className = className;
            this.children = [];
            this.parentNode = null;
            this.hidden = false;
            this.style = {};
            this.attributes = new Map();
            this.listeners = new Map();
            this.ownText = '';
            this.classList = {
                add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
                remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); }
            };
        }
        get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
        get previousElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] ?? null; }
        get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
        set textContent(value) {
            this.children.forEach(child => { child.parentNode = null; });
            this.children = [];
            this.ownText = String(value);
        }
        matches(selector) {
            return selector.split(',').some(part => {
                part = part.trim();
                if (part.startsWith('.')) return part.slice(1).split('.').every(name => this.className.split(/\s+/).includes(name));
                if (part === '[hidden]') return this.hidden;
                const attribute = part.match(/^\[([^\]]+)\]$/);
                return attribute ? this.hasAttribute(attribute[1]) : false;
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
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        hasAttribute(name) { return this.attributes.has(name); }
        removeAttribute(name) { this.attributes.delete(name); }
        getClientRects() { return this.isConnected && !this.closest('.hide, [hidden]') ? [{}] : []; }
        getBoundingClientRect() { return { top: 2000 }; }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        remove() {
            if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
            this.parentNode = null;
        }
        insertAdjacentElement(position, element) {
            assert.equal(position, 'afterend');
            element.remove();
            this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, element);
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
        body: new Element(), head: new Element(),
        createElement: () => new Element(), addEventListener() {},
        querySelectorAll: selector => document.body.querySelectorAll(selector)
    };
    const view = document.body.appendChild(new Element('page'));
    const items = view.appendChild(new Element('itemsContainer vertical-wrap'));
    const pager = view.appendChild(new Element('paging'));
    const next = pager.appendChild(new Element('btnNextPage'));
    pager.appendChild(new Element('btnPreviousPage'));
    view.appendChild(new Element('alphaPicker'));
    const actions = {};
    for (const action of ['Play', 'Queue', 'Shuffle']) actions[action.toLowerCase()] = view.appendChild(new Element(`btn${action}`));
    const window = {
        JellyfinInfiniteScrollConfig: config,
        document, location: { href: 'https://jellyfin.example/web/#/list?genreId=comedy&parentId=movies-library&serverId=server-1' },
        // A different globally selected server must not replace the native
        // category controller's authenticated ServerConnections client.
        ApiClient: { getCurrentUserId: () => 'other-server-user' },
        innerHeight: 800, addEventListener() {}, scrollTo() {},
        requestAnimationFrame: callback => frames.push(callback), setTimeout() {},
        MutationObserver: class { observe() {} },
        IntersectionObserver: class {
            constructor(callback) { this.callback = callback; this.connected = true; observers.push(this); }
            observe() {} disconnect() { this.connected = false; }
        }
    };
    return {
        window, view, items, pager, next, actions,
        get sentinel() { return view.querySelector('.jellyfin-infinite-scroll-sentinel'); },
        frames() {
            let count = 0;
            while (frames.length) {
                assert.ok(++count < 30, 'Unexpected category render loop');
                frames.shift()();
            }
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
    return candidates[0];
}

function createController(source, runtimeSource, config = {}, { runtime = true, olderRuntime = false, item, params, sort } = {}) {
    const boundary = createBoundary(config);
    const context = vm.createContext({ window: boundary.window, document: boundary.window.document, DOMException, console });
    if (runtime) vm.runInContext(runtimeSource, context);
    if (olderRuntime) delete boundary.window.JellyfinInfiniteScroll.legacyList;
    const factory = nativeFactory(source, context);
    const text = factory.toString();
    const requests = [];
    const itemRequests = [];
    const rendered = [];
    const playback = [];
    const records = Array.from({ length: 225 }, (_unused, index) => ({ Id: `movie-${index}`, Name: `Movie ${index}` }));
    const state = {
        sort: sort ?? { sortBy: 'SortName', sortOrder: 'Ascending' },
        filters: { IsFavorite: true }, alphabet: 'A',
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
        return { Items: records.slice(offset, offset + (query.Limit ?? records.length)), TotalRecordCount: records.length, StartIndex: offset };
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
    bindUsage('getCardsHtml', { getCardsHtml(options) { rendered.push(options); return `cards:${options.items.length}`; } });
    bindUsage('getListViewHtml', { getListViewHtml(options) { rendered.push(options); return `rows:${options.items.length}`; } });
    bindUsage('getQueryPagingHtml', { getQueryPagingHtml: query => JSON.stringify(query) });
    bindUsage('canQueue', {
        canQueue: () => true,
        play: options => playback.push({ action: 'play', options }),
        queue: options => playback.push({ action: 'queue', options }),
        shuffle: item => playback.push({ action: 'shuffle', item })
    });
    bindUsage('setTitle', { setTitle() {} });
    bindUsage('autoFocus', { autoFocus() {}, focus() {} });
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
    const require = id => imports.get(id) ?? (id === 84069 ? { default: { autoFocus() {} } } : {});
    require.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
    require.d = (exports, getters) => {
        for (const [name, getter] of Object.entries(getters)) Object.defineProperty(exports, name, { get: getter, enumerable: true });
    };
    const exports = {};
    factory({ exports }, exports, require);
    assert.equal(typeof exports.default, 'function', 'Native list constructor is exported');
    const nativeParams = params ?? { genreId: 'comedy', parentId: 'movies-library', serverId: 'server-1' };
    const instance = new exports.default(boundary.view, nativeParams);
    instance.currentItem = state.item;
    instance.alphaPicker = { value: () => state.alphabet };
    let result;
    boundary.items.refreshItems = async () => {
        result = await boundary.items.fetchData();
        boundary.items.getItemsHtml(result.Items);
        return result;
    };
    boundary.items.resume = () => boundary.items.refreshItems();
    boundary.items.pause = () => {};
    return { boundary, instance, state, requests, itemRequests, rendered, playback, records,
        get result() { return result; }, fetch: boundary.items.refreshItems };
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
    assert.equal(h.rendered.at(-1).items.length, batchSize * 2, 'Native card renderer receives accumulated results');
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
    console.log(`PASS: actual Movies > Categories > Comedy controller, batch ${batchSize}, native category/parent/auth/filter/sort/alpha queries, accumulated renderer, and hidden pagination.`);
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
    const runtimeSource = await readFile('src/Jellyfin.Plugin.InfiniteScroll/Web/infinite-scroll.js', 'utf8');
    for (const batchSize of [100, 7]) await exerciseCategory(source, runtimeSource, batchSize);
    await exerciseFallback(source, runtimeSource, { enabled: false }, {}, 'Disabled category extension');
    await exerciseFallback(source, runtimeSource, {}, { runtime: false }, 'Unavailable category extension');
    await exerciseFallback(source, runtimeSource, {}, { olderRuntime: true }, 'Already loaded older extension runtime');
    await exerciseFallback(source, runtimeSource, {}, { sort: { sortBy: 'Random', sortOrder: 'Ascending' } }, 'Random category sorting');
    await exerciseFallback(source, runtimeSource, {}, { item: { Id: 'folder-1', Type: 'Folder' } }, 'Non-category folder list');
    await exerciseOtherCategories(source, runtimeSource);
    await exercisePlayback(source, runtimeSource);
    console.log(`PASS: production category bridge ${name}.`);
}

main().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
