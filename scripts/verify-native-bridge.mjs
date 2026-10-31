#!/usr/bin/env node
/** Execute the actual transformed Jellyfin Web query and toolbar in a small VM.
 * Generate .patched.js files with tests/Transformations before running this.
 * Upstream fixtures are local research inputs and are not redistributed.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { identifyWebAsset, locateModernToolbar, matchingDelimiter } from './verify-web.mjs';

const fixtureDirectory = process.argv[2] ?? '.research/production';
const runtimePath = 'src/Jellyfin.Plugin.InfiniteScroll/Web/infinite-scroll.js';
const normalize = value => JSON.parse(JSON.stringify(value));
const enumNames = new Proxy({}, { get: (_target, property) => String(property) });
const libraryTabs = new Proxy({}, { get: (_target, property) => String(property).toLowerCase() });

function createBoundary(config) {
    const frames = [];
    let intersection;
    let sentinel;
    class Element {
        constructor() { this.attributes = new Map(); this.style = {}; this.isConnected = true; }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        hasAttribute(name) { return this.attributes.has(name); }
        getClientRects() { return [{}]; }
        closest() { return null; }
        getBoundingClientRect() { return { top: 2000 }; }
        remove() { this.isConnected = false; }
        appendChild() {}
        addEventListener() {}
    }
    const host = new Element();
    host.insertAdjacentElement = (_position, element) => {
        sentinel = element;
        element.previousElementSibling = host;
    };
    const document = {
        body: {}, head: { appendChild() {} },
        createElement: () => new Element(),
        addEventListener() {},
        querySelectorAll(selector) {
            return selector.includes('.itemsContainer.vertical-wrap') ? [host] : [];
        }
    };
    const window = {
        JellyfinInfiniteScrollConfig: config,
        document, location: { href: 'https://jellyfin.example/web/#/movies?topParentId=library-1' },
        innerHeight: 800, addEventListener() {},
        requestAnimationFrame: callback => frames.push(callback),
        setTimeout() {}, scrollTo() {},
        MutationObserver: class { observe() {} },
        IntersectionObserver: class {
            constructor(callback) { intersection = callback; }
            observe() {} disconnect() {}
        }
    };
    return {
        window,
        frames() {
            let count = 0;
            while (frames.length) {
                assert.ok(++count < 30, 'Unexpected render loop');
                frames.shift()();
            }
        },
        intersect() {
            assert.ok(sentinel && intersection, 'Native query produced an observed sentinel');
            intersection([{ isIntersecting: true }]);
        }
    };
}

/** Capture webpack factories by evaluating the shipped registration statement. */
function factoryFor(source, context, fingerprint) {
    context.self = { webpackChunk: [] };
    vm.runInContext(source, context);
    const factories = context.self.webpackChunk.flatMap(chunk => Object.values(chunk[1]));
    const candidates = factories.filter(factory => fingerprint(factory.toString()));
    assert.equal(candidates.length, 1, 'Expected one matching native webpack module');
    return candidates[0];
}

async function exerciseQuery(source, runtimeSource, config, { runtime = true } = {}) {
    const boundary = createBoundary(config);
    const context = vm.createContext({ window: boundary.window, DOMException, console });
    if (runtime) vm.runInContext(runtimeSource, context);
    const requests = [];
    const apiContext = { api: {}, user: { Id: 'user-1' } };
    let options;
    const result = {
        data: undefined, isPlaceholderData: false, isPending: false,
        async refetch(refetchOptions) {
            assert.equal(refetchOptions?.cancelRefetch, false);
            result.data = await options.queryFn({ signal: new AbortController().signal });
            return { data: result.data };
        }
    };
    const records = Array.from({ length: 225 }, (_unused, index) => ({ Id: `item-${index}`, Name: `Movie ${index}` }));
    const libraryApi = {
        async getItems(request, requestOptions) {
            requests.push({ request: normalize(request), signal: requestOptions.signal });
            return {
                data: {
                    Items: records.slice(request.startIndex, request.startIndex + request.limit),
                    TotalRecordCount: records.length, StartIndex: request.startIndex
                }
            };
        }
    };
    const imports = {
        64680: { y: enumNames }, 36873: { z: enumNames }, 92426: { s: enumNames },
        79096: { S: enumNames }, 77612: { B: enumNames }, 73921: { x: enumNames },
        71857: { Q: () => libraryApi },
        87395: { I: value => { options = value; return result; } },
        69410: { gf: () => apiContext },
        26542: {
            CF: (_view, settings) => ({ fields: ['MediaSourceCount', 'PrimaryImageAspectRatio'] }),
            Kp: (_view, settings) => ({ filters: settings.Filters.Status, genres: settings.Filters.Genres }),
            cm: () => ({ limit: 19 }),
            Z8: settings => ({ nameStartsWith: settings.Alphabet })
        },
        46850: { D: libraryTabs }, 58961: { u: enumNames }
    };
    const require = id => imports[id] ?? {};
    require.d = (exports, getters) => {
        for (const [name, getter] of Object.entries(getters)) Object.defineProperty(exports, name, { get: getter, enumerable: true });
    };
    const factory = factoryFor(source, context, text => text.includes('ViewByType') && text.includes('libraryViewSettings:'));
    const exports = {};
    factory({ exports }, exports, require);
    const hooks = Object.values(exports).filter(value => typeof value === 'function' && value.toString().includes('ViewByType'));
    assert.equal(hooks.length, 1, 'Native useGetItemsViewByType export was located');
    const hook = hooks[0];
    const settings = {
        StartIndex: 900, SortBy: ['SortName'], SortOrder: 'Ascending', ImageType: 'Primary', Alphabet: 'A',
        Filters: { Status: ['IsFavorite'], Genres: ['Drama'] }
    };
    const before = normalize(settings);
    assert.equal(hook('movies', 'library-1', ['Movie'], settings), result);
    const signal = new AbortController().signal;
    result.data = await options.queryFn({ signal });
    assert.equal(requests[0].signal, signal, 'Original AbortSignal reached the real native fetch');
    assert.deepEqual(normalize(settings), before, 'Native view settings were not mutated');
    const first = requests[0].request;
    assert.deepEqual(first.sortBy, ['SortName']);
    assert.deepEqual(first.sortOrder, ['Ascending']);
    assert.deepEqual(first.filters, ['IsFavorite']);
    assert.deepEqual(first.genres, ['Drama']);
    assert.equal(first.nameStartsWith, 'A');
    assert.equal(first.parentId, 'library-1');
    assert.equal(first.userId, 'user-1');
    assert.deepEqual(first.includeItemTypes, ['Movie']);

    const enabled = runtime && config.enabled !== false;
    if (enabled) {
        const batchSize = config.batchSize ?? 100;
        assert.equal(first.startIndex, 0);
        assert.equal(first.limit, batchSize);
        assert.equal(result.data.Items.length, batchSize);
        hook('movies', 'library-1', ['Movie'], settings);
        boundary.frames();
        boundary.intersect();
        await new Promise(resolve => setImmediate(resolve));
        boundary.frames();
        assert.equal(requests.length, 2, 'Sentinel refetched the native query once');
        assert.equal(requests[1].request.startIndex, batchSize);
        assert.equal(requests[1].request.limit, batchSize);
        assert.equal(result.data.Items.length, batchSize * 2, 'Actual native query result contains accumulated cards');
        assert.deepEqual(Array.from(result.data.Items, item => item.Id), records.slice(0, batchSize * 2).map(item => item.Id));
    } else {
        assert.equal(first.startIndex, 900, 'Original native offset remains when extension is unavailable/disabled');
        assert.equal(first.limit, 19, 'Original native user page size remains without a settings marker');
        assert.equal(result.data.__jellyfinInfiniteScroll, undefined);
    }
    return { context, boundary, result, settings, requests };
}

function exerciseToolbar(original, patched, queryState, expectedDisabled) {
    const location = locateModernToolbar(original);
    assert.ok(location, 'Original modern toolbar fixture was identified');
    const declaration = `${location.component}=function(){`;
    const start = patched.indexOf(declaration);
    assert.ok(start >= 0, 'Toolbar component declaration survives transformation');
    const bodyStart = patched.indexOf('{', start);
    const bodyEnd = matchingDelimiter(patched, bodyStart);
    const component = patched.slice(start + location.component.length + 1, bodyEnd + 1);
    const { context, result } = queryState;
    const library = {
        id: 'library-1', collectionType: 'movies', isLibraryPath: true,
        itemsResult: result,
        viewSettings: { StartIndex: 0, SortBy: ['SortName'] },
        content: { viewType: 'movies', itemType: ['Movie'], isPaginationEnabled: true },
        setViewSettings() {}
    };
    const render = (type, props) => ({ type, props });
    // Derive minified bindings from native calls and component props. Upstream
    // webpack IDs, import aliases and chunk hashes are free to change.
    for (const [pattern, value] of [
        [/\(0,([\w$]+)\.([\w$]+)\)\(\),[\w$]+=[\w$]+\.id,/, () => library],
        [/null!=[\w$]+\?[\w$]+:\(0,([\w$]+)\.([\w$]+)\)\(/, () => library.viewSettings],
        [/:([\w$]+)\.([\w$]+)\.Movies/, libraryTabs],
        [/\(0,([\w$]+)\.([\w$]+)\)\(\(function\([\w$]+\)\{return [\w$]+\.breakpoints\.up\("sm"\)/, () => true],
        [/\(0,([\w$]+)\.([\w$]+)\)\([^)]*\)\.data/, () => ({ data: {} })],
        [/\(0,([\w$]+)\.([\w$]+)\)\(\)\.user/, () => ({ user: { Id: 'user-1', Policy: {} } })],
        [/([\w$]+)\.(useMemo)\)\(/, fn => fn()],
        [/\(0,([\w$]+)\.([\w$]+)\)\(\)\.libraryPageSize/, () => ({ libraryPageSize: 19 })],
        [/([\w$]+)\.([\w$]+)\.translate\("ListPaging"/, { translate: (key, ...args) => `${key}:${args.join(',')}` }],
        [/\(0,[\w$]+\.jsxs\)\(([\w$]+)\.([\w$]+),\{variant:"dense"/, 'Toolbar'],
        [/\(0,[\w$]+\.jsx\)\(([\w$]+)\.([\w$]+),\{label:/, 'Chip'],
        [/\(0,[\w$]+\.jsxs\)\(([\w$]+)\.([\w$]+),\{sx:\{display:"flex"/, 'Box'],
        [/\(0,[\w$]+\.jsxs\)\(([\w$]+)\.([\w$]+),\{direction:"row"/, 'Stack'],
        [/\(0,[\w$]+\.jsxs\)\(([\w$]+)\.([\w$]+),\{variant:"contained"/, 'ButtonGroup']
    ]) {
        const binding = component.match(pattern);
        assert.ok(binding, `Missing native toolbar binding: ${pattern}`);
        context[binding[1]] = { ...context[binding[1]], [binding[2]]: value };
    }
    for (const [pattern, value] of [
        [/\(0,([\w$]+)\.jsxs\)\(/, { jsx: render, jsxs: render, Fragment: 'Fragment' }],
        [/!([\w$]+)\.includes\(/, []],
        [/children:\[\(0,[\w$]+\.jsx\)\(([\w$]+),\{\}\)/, 'LibraryViewMenu'],
        [/\(0,[\w$]+\.jsx\)\(([\w$]+),\{setLibraryViewSettings:/, 'Pagination']
    ]) {
        const binding = component.match(pattern);
        assert.ok(binding, `Missing native toolbar binding: ${pattern}`);
        context[binding[1]] = value;
    }
    vm.runInContext(`globalThis.nativeToolbar = ${component}`, context);
    const tree = context.nativeToolbar();
    const flattened = [];
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        flattened.push(node);
        walk(node.props?.children);
    }
    walk(tree);
    const chips = flattened.filter(node => node.type === 'Chip');
    assert.equal(chips.length, 1);
    const arrows = flattened.filter(node => node.type === 'Pagination');
    if (expectedDisabled) {
        assert.equal(arrows.length, 0, 'Actual toolbar omits native pagination arrows');
        assert.equal(chips[0].props.label, 225, 'Actual toolbar shows the total unpaginated count');
    } else {
        assert.equal(arrows.length, 1, 'Native pagination remains when extension is disabled');
        assert.equal(chips[0].props.label, 'ListPaging:1,19,225');
    }
}

async function main() {
    const files = await readdir(fixtureDirectory);
    const assets = [];
    for (const name of files.filter(name => name.endsWith('.chunk.js'))) {
        const asset = identifyWebAsset(await readFile(path.join(fixtureDirectory, name), 'utf8'));
        if (asset) assets.push({ ...asset, name: name + '.patched.js' });
    }
    assert.equal(assets.filter(asset => asset.kind === 'modern-library').length, 1, 'Expected one native modern query fixture');
    assert.equal(assets.filter(asset => asset.kind === 'modern-toolbar').length, 1, 'Expected one native modern toolbar fixture');
    const queryName = assets.find(asset => asset.kind === 'modern-library')?.name;
    const toolbarName = assets.find(asset => asset.kind === 'modern-toolbar')?.name;
    assert.ok(queryName && toolbarName, 'Generate modern query and toolbar .patched.js fixtures first');
    const [query, toolbar, originalToolbar, runtimeSource] = await Promise.all([
        readFile(path.join(fixtureDirectory, queryName), 'utf8'),
        readFile(path.join(fixtureDirectory, toolbarName), 'utf8'),
        readFile(path.join(fixtureDirectory, toolbarName.replace(/\.patched\.js$/, '')), 'utf8'),
        readFile(runtimePath, 'utf8')
    ]);
    for (const batchSize of [100, 7]) {
        const enabled = await exerciseQuery(query, runtimeSource, { batchSize });
        exerciseToolbar(originalToolbar, toolbar, enabled, true);
        console.log(`PASS: actual native query + toolbar, batch ${batchSize}, cloned filters/sort, signal, accumulation, total count, and no pagination arrows.`);
    }
    const disabled = await exerciseQuery(query, runtimeSource, { enabled: false });
    exerciseToolbar(originalToolbar, toolbar, disabled, false);
    console.log('PASS: disabled extension preserves native offset, page size, count, and pagination arrows.');
    await exerciseQuery(query, runtimeSource, {}, { runtime: false });
    console.log('PASS: unavailable extension preserves original native query behavior.');
}

main().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
