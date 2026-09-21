import type { LoggerInstance } from 'moleculer';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { NotFoundError } from '../src/errors.js';
import {
    getServer,
    HttpServer,
    type ServerRequest,
    type ServerSettings,
    setServer,
} from '../src/server.js';

const logger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
} as unknown as LoggerInstance;

interface Hit {
    path: string;
    url: string;
    reqUrl: string | undefined;
    originalUrl: string | undefined;
    baseUrl: string | undefined;
    method: string | undefined;
}

const servers: HttpServer[] = [];

async function start(options: Partial<ServerSettings> = {}) {
    const server = new HttpServer({ port: 0, ip: '127.0.0.1', logging: false, ...options }, logger);
    servers.push(server);
    const address = await server.listen();
    return { server, url: `http://127.0.0.1:${address.port}` };
}

function recorder(hits: Hit[], body = 'ok') {
    return ({ req, res, path, url }: ServerRequest) => {
        hits.push({
            path,
            url,
            reqUrl: req.url,
            originalUrl: req.originalUrl,
            baseUrl: req.baseUrl,
            method: req.method,
        });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(body);
    };
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('HttpServer mounts', () => {
    it('serves an exact mount on its own path, trailing slash included', async () => {
        const hits: Hit[] = [];
        const { server, url } = await start();
        server.mount('/sidecar', recorder(hits), 'exact');

        expect(await (await fetch(`${url}/sidecar`, { method: 'POST' })).text()).toBe('ok');
        expect(await (await fetch(`${url}/sidecar/`, { method: 'POST' })).text()).toBe('ok');
        // The mount matches any method; filtering is the handler's job.
        expect(await (await fetch(`${url}/sidecar`, { method: 'GET' })).text()).toBe('ok');

        expect(hits.map((hit) => [hit.method, hit.url])).toEqual([
            ['POST', '/sidecar'],
            ['POST', '/sidecar'],
            ['GET', '/sidecar'],
        ]);
        // Exact mounts are not rewritten.
        expect(hits[0].reqUrl).toBe('/sidecar');
    });

    it('strips the prefix for prefix mounts and keeps the original url', async () => {
        const hits: Hit[] = [];
        const { server, url } = await start();
        server.mount('/lab', recorder(hits));

        await fetch(`${url}/lab`);
        await fetch(`${url}/lab/assets/app.js?v=1`);

        expect(hits[0]).toMatchObject({
            path: '/',
            url: '/lab',
            reqUrl: '/',
            originalUrl: '/lab',
            baseUrl: '/lab',
        });
        expect(hits[1]).toMatchObject({
            path: '/assets/app.js',
            url: '/lab/assets/app.js',
            reqUrl: '/assets/app.js?v=1',
        });
    });

    it('routes to the longest matching prefix', async () => {
        const root: Hit[] = [];
        const nested: Hit[] = [];
        const { server, url } = await start();
        server.mount('/ui', recorder(root, 'ui'));
        server.mount('/ui/api', recorder(nested, 'api'));

        expect(await (await fetch(`${url}/ui/page`)).text()).toBe('ui');
        expect(await (await fetch(`${url}/ui/api/tokens`)).text()).toBe('api');
        expect(root[0].path).toBe('/page');
        expect(nested[0].path).toBe('/tokens');
    });

    it('does not match a prefix that is only a string prefix', async () => {
        const hits: Hit[] = [];
        const { server, url } = await start();
        server.mount('/lab', recorder(hits));

        const response = await fetch(`${url}/labx`);
        expect(response.status).toBe(404);
        expect(hits).toHaveLength(0);
    });

    it('rejects a duplicate mount and supports unmounting', async () => {
        const hits: Hit[] = [];
        const { server, url } = await start();
        const unmount = server.mount('/lab', recorder(hits));

        expect(() => server.mount('/lab', recorder(hits))).toThrow('mount already registered');

        unmount();
        expect((await fetch(`${url}/lab`)).status).toBe(404);
    });
});

describe('HttpServer slash redirect', () => {
    it('redirects the bare prefix, keeping the query string', async () => {
        const hits: Hit[] = [];
        const { server, url } = await start();
        server.mount('/lab', recorder(hits), { slashRedirect: true });

        const redirect = await fetch(`${url}/lab?tab=registry`, { redirect: 'manual' });
        expect(redirect.status).toBe(307);
        expect(redirect.headers.get('location')).toBe('/lab/?tab=registry');

        await fetch(`${url}/lab/`);
        expect(hits[0]).toMatchObject({ path: '/', url: '/lab', reqUrl: '/' });

        await fetch(`${url}/lab/api/project`);
        expect(hits[1]).toMatchObject({ path: '/api/project', reqUrl: '/api/project' });
    });

    it('leaves mounts that did not opt in alone', async () => {
        const hits: Hit[] = [];
        const { server, url } = await start();
        server.mount('/lab', recorder(hits));

        expect((await fetch(`${url}/lab`)).status).toBe(200);
        expect(hits[0]).toMatchObject({ path: '/', url: '/lab', reqUrl: '/' });
    });
});

describe('HttpServer responses', () => {
    it('answers unmounted paths with a JSON 404', async () => {
        const { url } = await start();

        const response = await fetch(`${url}/nope`);
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
        await expect(response.json()).resolves.toMatchObject({
            name: 'NotFoundError',
            code: 404,
            type: 'NOT_FOUND',
        });
    });

    it('lets the fallback be replaced', async () => {
        const { server, url } = await start();
        server.setFallback(({ req, res }) => {
            res.writeHead(req.method === 'POST' ? 404 : 405);
            res.end();
        });

        expect((await fetch(`${url}/nope`, { method: 'POST' })).status).toBe(404);
        expect((await fetch(`${url}/nope`)).status).toBe(405);
    });

    it('maps a thrown moleculer error and a plain error', async () => {
        const { server, url } = await start();
        server.mount('/missing', () => {
            throw new NotFoundError('TOKEN_MISSING');
        });
        server.mount('/broken', () => {
            throw new Error('boom');
        });

        const missing = await fetch(`${url}/missing`);
        expect(missing.status).toBe(404);
        await expect(missing.json()).resolves.toMatchObject({ type: 'TOKEN_MISSING' });

        const broken = await fetch(`${url}/broken`);
        expect(broken.status).toBe(500);
        await expect(broken.json()).resolves.toMatchObject({ code: 500, message: 'boom' });
    });

    it('reports a rejection from an async handler', async () => {
        const { server, url } = await start();
        server.mount('/async', async () => {
            await Promise.resolve();
            throw new NotFoundError('ASYNC_MISSING');
        });

        const response = await fetch(`${url}/async`);
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ type: 'ASYNC_MISSING' });
    });
});

describe('HttpServer lifecycle', () => {
    it('closes an idle server without error', async () => {
        const server = new HttpServer({ port: 0, ip: '127.0.0.1', logging: false }, logger);
        await expect(server.close()).resolves.toBeUndefined();
    });

    it('exposes the instance through the shared registry', async () => {
        expect(() => getServer()).toThrow('http server is not available yet');

        const { server } = await start();
        setServer(server);
        expect(getServer()).toBe(server);
    });
});
