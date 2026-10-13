#!/usr/bin/env node
/**
 * Inspect actual Jellyfin Web production chunks without installing dependencies.
 * Public upstream fixtures belong in the ignored .research/production directory.
 *
 *   node scripts/verify-web.mjs [.research/production]
 *   node scripts/verify-web.mjs --syntax path/to/transformed.chunk.js
 */
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const IDENTIFIER = '[A-Za-z_$][\\w$]*';

/** Match delimiters in the query expression, respecting strings and comments. */
export function matchingDelimiter(source, start) {
    const endings = { '{': '}', '(': ')', '[': ']' };
    assert.ok(endings[source[start]], `No opening delimiter at ${start}`);
    const stack = [endings[source[start]]];
    let quote = null;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            quote = character;
            continue;
        }
        if (character === '/' && source[index + 1] === '/') {
            const newline = source.indexOf('\n', index + 2);
            index = newline < 0 ? source.length : newline;
            continue;
        }
        if (character === '/' && source[index + 1] === '*') {
            const end = source.indexOf('*/', index + 2);
            assert.ok(end >= 0, 'Unterminated comment');
            index = end + 1;
            continue;
        }
        if (endings[character]) stack.push(endings[character]);
        else if ('})]'.includes(character)) {
            assert.equal(character, stack.pop(), `Mismatched delimiter at ${index}`);
            if (!stack.length) return index;
        }
    }
    throw new Error(`Unterminated expression beginning at ${start}`);
}

/** Locate the unmodified modern library query, independent of minified names. */
export function locateModernHook(source) {
    const anchors = [...source.matchAll(/\{\s*queryKey\s*:\s*\[/g)]
        .filter(({ index }) => {
            const keyStart = source.indexOf('[', index);
            const keyEnd = matchingDelimiter(source, keyStart);
            return /["']ViewByType["']/.test(source.slice(keyStart, keyEnd + 1));
        });
    if (!anchors.length) return null;
    assert.equal(anchors.length, 1, 'Expected one modern library query per chunk');

    const optionsStart = anchors[0].index;
    const optionsEnd = matchingDelimiter(source, optionsStart);
    const options = source.slice(optionsStart, optionsEnd + 1);
    const settingsMatch = options.match(new RegExp(`libraryViewSettings\\s*:\\s*(${IDENTIFIER})`));
    assert.ok(settingsMatch, 'Missing library settings in query key');
    const outerSettings = settingsMatch[1];

    const queryFnStart = options.indexOf('queryFn:');
    assert.ok(queryFnStart >= 0, 'Missing native queryFn');
    const queryFnSource = options.slice(queryFnStart);
    const fetchFunction = queryFnSource.match(/return\s+function\s*\(([^)]*)\)/);
    assert.ok(fetchFunction, 'Expected inline native fetch function');
    const fetchParameters = fetchFunction[1].split(',').map(parameter => parameter.trim());
    assert.equal(fetchParameters.length, 6, 'Expected six native fetch parameters');
    const innerSettings = fetchParameters[4];
    assert.match(innerSettings, new RegExp(`^${IDENTIFIER}$`));

    const nativeInvocation = queryFnSource.match(new RegExp(
        `\\}\\((${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER}),${outerSettings},\\{signal:(${IDENTIFIER})\\}\\)`
    ));
    assert.ok(nativeInvocation, 'Missing native fetch invocation with original settings');

    const offsetMatches = [...options.matchAll(new RegExp(`startIndex:${innerSettings}\\.StartIndex`, 'g'))];
    assert.equal(offsetMatches.length, 7, 'Expected seven request offset fields');
    assert.equal([...options.matchAll(/\.getItems\(/g)].length, 2, 'Expected folder and recursive item requests');
    assert.match(options, /refetchOnWindowFocus:!1/);

    return {
        optionsStart,
        optionsEnd,
        outerSettings,
        innerSettings,
        fetchParameters,
        nativeInvocation: nativeInvocation[0],
        requestOffsetCount: offsetMatches.length,
        libraryViewCount: (options.match(/\.Movies|\.Series|\.Episodes|\.Mixed/g) ?? []).length
    };
}

export function identifyLegacyController(source) {
    if (!source.includes('btnNextPage') || !source.includes('ApiClient.getItems')) return null;
    const isMovie = source.includes('IncludeItemTypes:"Movie"') && source.includes('context:"movies"');
    const isSeries = source.includes('IncludeItemTypes:"Series"') && source.includes('context:"tvshows"');
    if (!isMovie && !isSeries) return null;
    assert.notEqual(isMovie, isSeries, 'Ambiguous legacy controller chunk');
    assert.ok(source.includes('window.scrollTo(0,0)'), 'Missing native paging scroll reset');
    assert.ok(source.includes('btnPreviousPage'), 'Missing native previous-page control');
    return {
        kind: isMovie ? 'legacy-movies' : 'legacy-series',
        itemRequestCount: (source.match(/ApiClient\.getItems\(/g) ?? []).length,
        scrollResetCount: (source.match(/window\.scrollTo\(0,0\)/g) ?? []).length,
        usesItemsContainerRefresh: source.includes('.refreshItems()')
    };
}

/** Locate the toolbar's native page-size/count/arrow decision in shipped code. */
export function locateModernToolbar(source) {
    const anchor = source.indexOf('"ListPaging"');
    if (anchor < 0 || !source.includes('isPaginationEnabled')) return null;
    const components = [...source.matchAll(new RegExp(`(${IDENTIFIER})=function\\(\\)\\{`, 'g'))]
        .filter(match => match.index < anchor)
        .map(match => ({
            name: match[1],
            start: source.indexOf('{', match.index),
            declarationStart: match.index
        }))
        .filter(component => matchingDelimiter(source, component.start) > anchor);
    assert.ok(components.length, 'Missing enclosing toolbar component');
    const component = components.at(-1);
    const end = matchingDelimiter(source, component.start);
    const body = source.slice(component.start, end + 1);
    assert.ok(body.includes('isPaginationEnabled'), 'Unexpected ListPaging component');

    const size = body.match(new RegExp(`(${IDENTIFIER})=\\(0,${IDENTIFIER}\\.${IDENTIFIER}\\)\\(\\)\\.libraryPageSize`));
    assert.ok(size, 'Missing toolbar native page-size getter');
    const limit = size[1];
    const enabled = body.match(new RegExp(`(${IDENTIFIER})=${limit}>0`));
    assert.ok(enabled, 'Missing toolbar user-pagination flag');
    const required = body.match(new RegExp(`(${IDENTIFIER})=${enabled[1]}&&${limit}<(${IDENTIFIER})`));
    assert.ok(required, 'Missing toolbar pagination-required flag');
    const count = body.match(new RegExp(`translate\\("ListPaging",(${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER})\\)`));
    assert.ok(count, 'Missing toolbar native page-range count');
    assert.equal(count[3], required[2], 'Toolbar total binding differs between range and pagination');
    assert.ok(body.includes('isPlaceholderData'), 'Missing toolbar native loading disablement');
    return {
        component: component.name,
        componentStart: component.start,
        componentEnd: end,
        pageSize: limit,
        paginationEnabled: enabled[1],
        paginationRequired: required[1],
        total: count[3],
        rangeStart: count[1],
        rangeEnd: count[2],
        nativeFlag: enabled[0]
    };
}

async function collectFiles(input) {
    const info = await stat(input);
    if (!info.isDirectory()) return [input];
    return (await readdir(input))
        .filter(name => name.endsWith('.js') && !name.endsWith('.patched.js'))
        .sort()
        .map(name => path.join(input, name));
}

async function main() {
    const args = process.argv.slice(2);
    const syntaxOnly = args[0] === '--syntax';
    if (syntaxOnly) args.shift();
    const inputs = args.length ? args : ['.research/production'];
    const files = (await Promise.all(inputs.map(collectFiles))).flat();
    assert.ok(files.length, 'No JavaScript fixtures found');
    const report = [];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        new Script(source, { filename: file });
        if (syntaxOnly) {
            report.push({ file, syntax: 'valid', bytes: Buffer.byteLength(source) });
            continue;
        }
        const modern = locateModernHook(source);
        const legacy = identifyLegacyController(source);
        const toolbar = locateModernToolbar(source);
        if (modern) report.push({ file, kind: 'modern-library', syntax: 'valid', ...modern });
        else if (legacy) report.push({ file, syntax: 'valid', ...legacy });
        else if (toolbar) report.push({ file, kind: 'modern-toolbar', syntax: 'valid', ...toolbar });
    }
    assert.ok(report.length, 'No supported library controller/query fingerprints found');
    if (!args.length && !syntaxOnly) {
        for (const kind of ['modern-library', 'legacy-movies', 'legacy-series', 'modern-toolbar']) {
            assert.equal(report.filter(entry => entry.kind === kind).length, 1, `Missing or duplicate ${kind} fixture`);
        }
    }
    console.log(JSON.stringify({ verified: true, files: report }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Jellyfin Web verification failed: ${error.message}`);
        process.exitCode = 1;
    });
}
