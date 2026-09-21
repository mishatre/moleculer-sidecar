import { readFileSync } from 'node:fs';
import path from 'node:path';
import { action, defineSettings, method, service, started, stopped } from 'moldecor';
import type { Context } from 'moleculer';
import ApiGateway from 'moleculer-web';
import { NotFoundError, ServiceUnavailableError, UnAuthorizedError } from '../errors.js';
import { Service as MoleculerService } from '../runtime/cjs-interop.js';
import { findAppRoot } from '../runtime/paths.js';
import { getServer, type ServerRequest } from '../server.js';
import type { IncomingMessage, ServerResponse } from '../types.js';
import {
    assertUiAccess,
    clearedSessionCookie,
    createSession,
    csrfToken,
    resolveUiAuth,
    sessionCookie,
    type UiAuth,
    verifyPassword,
} from '../ui/auth.js';

const UI_PATH = '/ui';
// Resolved against the project root, not this module: compiled sources sit one
// level deeper (dist/src/services) than the sources do, which would otherwise
// point at dist/ui/dist. The packaged build stages ui/dist at the project root.
const UI_DIST = path.join(findAppRoot(), 'ui', 'dist');
const INDEX_FILE = path.join(UI_DIST, 'index.html');

type Middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
) => void;

export interface LoginResponse {
    csrfToken: string;
}

export interface TokenListResponse {
    accessKey: string;
}

export interface TokenPairResponse {
    accessKey: string;
    secretKey: string;
}

interface LoginParams {
    password: string;
}

interface RevokeParams {
    accessKey: string;
}

/** Response fields moleculer-web consumes from `ctx.meta`. */
interface ResponseMeta {
    $responseHeaders?: Record<string, string>;
}

const auth: UiAuth = resolveUiAuth();

const settings = defineSettings({
    $secureSettings: ['auth'],

    // The shared listener owns the socket; this gateway only routes.
    server: false,
    path: '/',

    // Serve the built SPA (hashed assets, ETag, ranges).
    assets: {
        folder: UI_DIST,
        options: { index: ['index.html'], redirect: false },
    },

    auth,

    // The gateway logs nothing itself: the shared server already logs every
    // request and every error response, and the gateway's aliases are logged
    // once at startup.
    logging: false,
    logRouteRegistration: 'debug',

    routes: [
        {
            path: '/',
            logging: false,
            aliases: {
                'POST /api/login': '$ui.login',
                'POST /api/logout': '$ui.logout',
                'GET /api/session': '$ui.session',
                'GET /api/tokens': '$ui.listTokens',
                'POST /api/tokens': '$ui.createToken',
                'DELETE /api/tokens/:accessKey': '$ui.revokeToken',
            },
        },
    ],
});

/**
 * Admin API for the sidecar access tokens plus the SPA that drives it. Named
 * `$ui` so moleculer keeps it off the bus: the gateway calls it locally.
 */
@service({
    name: '$ui',
    mixins: [ApiGateway],
    settings,
})
export default class UiService extends MoleculerService<typeof settings> {
    declare private express: () => Middleware;

    private unmount?: () => void;
    private indexHtml?: string;

    @action({ name: 'login', params: { password: 'string' } })
    public login(ctx: Context<LoginParams, ResponseMeta>): LoginResponse {
        if (!verifyPassword(ctx.params.password, this.settings.auth.passwordHash)) {
            this.logger.warn('Rejected an ui login attempt');
            throw new UnAuthorizedError('INVALID_PASSWORD');
        }

        const session = createSession(this.settings.auth.sessionSecret, this.settings.auth.ttlMs);

        ctx.meta.$responseHeaders = {
            'Set-Cookie': sessionCookie(session.value, {
                ttlMs: this.settings.auth.ttlMs,
                secure: this.server.secure,
            }),
        };
        this.logger.info('UI session opened');

        return { csrfToken: csrfToken(session.value, this.settings.auth.sessionSecret) };
    }

    @action({ name: 'logout' })
    public logout(ctx: Context<object, ResponseMeta>): { ok: boolean } {
        ctx.meta.$responseHeaders = {
            'Set-Cookie': clearedSessionCookie(this.server.secure),
        };

        return { ok: true };
    }

    @action({ name: 'session' })
    public session(): { authenticated: boolean } {
        return { authenticated: true };
    }

    @action({ name: 'listTokens' })
    protected async listTokens(ctx: Context): Promise<TokenListResponse[]> {
        return (await ctx.call(
            '$sidecar.auth.listAccessKeys',
            {},
            { parentCtx: ctx },
        )) as TokenListResponse[];
    }

    @action({ name: 'createToken' })
    protected async createToken(ctx: Context): Promise<TokenPairResponse> {
        const pair = (await ctx.call(
            '$sidecar.auth.generateAccessKey',
            {},
            { parentCtx: ctx },
        )) as TokenPairResponse;

        this.logger.info(`Created access key ${pair.accessKey} for the ui`);
        return pair;
    }

    @action({ name: 'revokeToken', params: { accessKey: 'string' } })
    protected async revokeToken(ctx: Context<RevokeParams>): Promise<{ ok: boolean }> {
        await ctx.call('$sidecar.auth.revokeAccessKey', ctx.params, { parentCtx: ctx });

        this.logger.info(`Revoked access key ${ctx.params.accessKey} for the ui`);
        return { ok: true };
    }

    @started
    public started() {
        this.indexHtml = readIndexHtml();
        this.unmount = getServer().mount(UI_PATH, (request) => this.handleRequest(request), {
            slashRedirect: true,
        });
    }

    @stopped
    public stopped() {
        this.unmount?.();
        this.unmount = undefined;
    }

    @method
    private handleRequest({ req, res, path }: ServerRequest) {
        assertUiAccess(req, res, this.settings.auth, path);

        // moleculer-web rebuilds `req.url` from `req.originalUrl` while routing
        // (its `settings.path` is '/', so no prefix is re-added) and then hands
        // `req.url` to serve-static. Ours still carries the `/ui` mount that the
        // dispatcher stripped, which made serve-static look for
        // `<dist>/ui/assets/*` and miss every bundle file. Inside the mount the
        // mount-relative url *is* the original one.
        req.originalUrl = req.url;

        this.express()(req, res, (error?: unknown) => {
            if (error) {
                return this.server.sendError(req, res, error);
            }
            return this.serveIndex(req, res, path);
        });
    }

    /**
     * Fallback for requests no route and no asset matched: the SPA owns every
     * GET below the mount, everything else is a 404.
     */
    @method
    private serveIndex(req: IncomingMessage, res: ServerResponse, path: string) {
        if (req.method !== 'GET') {
            return this.server.send404(req, res);
        }
        if (path.startsWith('/api')) {
            return this.server.sendError(req, res, new NotFoundError('UNKNOWN_UI_API_ROUTE'));
        }
        if (!this.indexHtml) {
            return this.server.sendError(req, res, new ServiceUnavailableError('UI_NOT_BUILT'));
        }

        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
        });
        res.end(this.indexHtml);
    }

    private get server() {
        return getServer();
    }
}

function readIndexHtml(): string | undefined {
    try {
        return readFileSync(INDEX_FILE, 'utf8');
    } catch {
        return undefined;
    }
}
