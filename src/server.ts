import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import kleur from 'kleur';
import _ from 'lodash';
import type { Errors as ErrorsType, LoggerInstance } from 'moleculer';
import { convertToMoleculerError, isMoleculerError, NotFoundError } from './errors.js';
import { Errors } from './runtime/cjs-interop.js';
import type { IncomingMessage, ServerResponse } from './types.js';
import { parseRequestURL } from './utils/utils.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Listener configuration shared by every service that serves through the server.
 */
export interface ServerSettings {
    port: string | number;
    // Exposed IP
    ip: string;

    // Use HTTPS server
    https:
        | null
        | false
        | {
              key: string;
              cert: string;
          };
    // Use HTTP2 server (experimental)
    http2: boolean;
    // HTTP Server Timeout
    httpServerTimeout: number | null;
    // Request Timeout. More info: https://github.com/moleculerjs/moleculer-web/issues/206
    requestTimeout: number;
    //
    logging: boolean;
    // Log each request (default to "info" level)
    logRequest: LogLevel | null;
    // Log the request ctx.params (default to "debug" level)
    logRequestParams: LogLevel | null;
    // Log each response (default to "info" level)
    logResponse: LogLevel | null;
    // Log the response data (default to disable)
    logResponseData: LogLevel | null;
    // If set to true, it will log 4xx client errors, as well
    log4XXResponses: boolean;
}

export const serverSettings: Partial<ServerSettings> = {
    // Exposed port
    port: Number(process.env.PORT) || 5103,

    // Exposed IP
    ip: process.env.IP || '0.0.0.0',

    //
    logging: true,

    // Log each request (default to "info" level)
    logRequest: 'info',

    // Log the request ctx.params (default to "debug" level)
    logRequestParams: 'debug',

    // Log each response (default to "info" level)
    logResponse: 'info',

    // Log the response data (default to disable)
    logResponseData: null,

    // If set to true, it will log 4xx client errors, as well
    log4XXResponses: false,
};

export interface ServerRequest {
    req: IncomingMessage;
    res: ServerResponse;
    // Request path with the mount prefix removed
    path: string;
    // Request path as received, trailing slash trimmed
    url: string;
    query: Record<string, string>;
}

export type RequestHandler = (request: ServerRequest) => void | Promise<void>;

/**
 * - `exact`: only the prefix itself matches; the request URL is left alone.
 * - `prefix`: the prefix and everything under it match; the prefix is stripped
 *   from `req.url` (`req.baseUrl` gets it) so the handler sees the remainder.
 */
export type MountMode = 'exact' | 'prefix';

export interface MountOptions {
    mode?: MountMode;
    /**
     * Answer the bare prefix with a redirect to `prefix/`, so relative URLs in a
     * document served from there resolve under the mount.
     */
    slashRedirect?: boolean;
}

interface Mount {
    prefix: string;
    mode: MountMode;
    slashRedirect: boolean;
    handler: RequestHandler;
}

let shared: HttpServer | undefined;

export function setServer(server: HttpServer): void {
    shared = server;
}

/**
 * The process-wide listener every service serves through.
 */
export function getServer(): HttpServer {
    if (!shared) {
        throw new Error('http server is not available yet');
    }
    return shared;
}

/**
 * A single HTTP(S) listener. Handlers are mounted under a path prefix and
 * requests are dispatched to the longest matching mount.
 */
export class HttpServer {
    private readonly listener: http.Server | http2.Http2Server;
    public readonly secure: boolean;
    private readonly mounts: Mount[] = [];
    private fallback: RequestHandler = ({ req, res }) =>
        this.sendError(req, res, new NotFoundError());

    private readonly settings: ServerSettings;

    constructor(
        options: Partial<ServerSettings>,
        private readonly logger: LoggerInstance,
        private readonly name = 'HTTP server',
    ) {
        // Callers hand over the settings they resolved; gaps fall back to the defaults.
        this.settings = { ...serverSettings, ...options } as ServerSettings;

        if (this.settings.https && this.settings.https.key && this.settings.https.cert) {
            const tls = this.settings.https;
            this.secure = true;
            this.listener = this.settings.http2
                ? http2.createSecureServer(
                      tls,
                      this.handle as unknown as Parameters<typeof http2.createSecureServer>[1],
                  )
                : https.createServer(
                      tls,
                      this.handle as unknown as Parameters<typeof https.createServer>[1],
                  );
        } else {
            this.secure = false;
            this.listener = this.settings.http2
                ? http2.createServer(
                      this.handle as unknown as Parameters<typeof http2.createServer>[0],
                  )
                : http.createServer(
                      this.handle as unknown as Parameters<typeof http.createServer>[0],
                  );
        }

        this.listener.on('error', (error: unknown) => {
            this.logger.error('Server error', error);
        });
    }

    /**
     * Mount a handler. Returns the function that removes the mount again.
     */
    public mount(
        prefix: string,
        handler: RequestHandler,
        options: MountMode | MountOptions = {},
    ): () => void {
        const { mode, slashRedirect } = typeof options === 'string' ? { mode: options } : options;
        const mount: Mount = {
            prefix: normalizePrefix(prefix),
            mode: mode ?? 'prefix',
            slashRedirect: slashRedirect ?? false,
            handler,
        };

        if (this.mounts.some((item) => item.prefix === mount.prefix && item.mode === mount.mode)) {
            throw new Error(`mount already registered: ${mount.prefix}`);
        }

        this.mounts.push(mount);

        return () => {
            const index = this.mounts.indexOf(mount);
            if (index >= 0) {
                this.mounts.splice(index, 1);
            }
        };
    }

    public setFallback(handler: RequestHandler): void {
        this.fallback = handler;
    }

    public listen(): Promise<AddressInfo> {
        return new Promise((resolve) => {
            this.listener.listen(Number(this.settings.port), this.settings.ip, () => {
                const addr = this.listener.address() as AddressInfo;
                const listenAddr =
                    addr.address === '0.0.0.0' && os.platform() === 'win32'
                        ? 'localhost'
                        : addr.address;
                this.logger.info(
                    `${this.name} listening on ${this.secure ? 'https' : 'http'}://${listenAddr}:${
                        addr.port
                    }`,
                );
                resolve(addr);
            });
        });
    }

    public close(): Promise<void> {
        if (!this.listener.listening) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            this.listener.close((error: unknown) => {
                if (error) {
                    return reject(error);
                }

                this.logger.info(`${this.name} stopped!`);
                resolve();
            });
        });
    }

    /**
     * Send an error response.
     */
    public sendError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
        if (res.headersSent) {
            this.logger.warn('Headers have already sent', req.url, error);
            return;
        }

        if (!error || !(error instanceof Error)) {
            res.writeHead(500);
            res.end('Internal Server Error');

            this.logResponse(req, res);
            return;
        }

        // Type guard
        if (!isMoleculerError(error)) {
            error = convertToMoleculerError(error);
            // MOOOOOORE TYPE GUARDS
            if (!isMoleculerError(error)) {
                res.writeHead(500);
                res.end('Internal Server Error');

                this.logResponse(req, res);
                return;
            }
        }

        // Return with the error as JSON object
        res.setHeader('content-type', 'application/json; charset=utf-8');

        const code = _.isNumber(error.code) && _.inRange(error.code, 400, 599) ? error.code : 500;
        res.writeHead(code);
        const errObj = this.reformatError(error);
        res.end(errObj !== undefined ? JSON.stringify(errObj) : '');

        this.logResponse(req, res);
    }

    public send404(req: IncomingMessage, res: ServerResponse): void {
        this.sendError(req, res, new NotFoundError());
    }

    public errorHandler(req: IncomingMessage, res: ServerResponse, error: unknown): void {
        // don't log client side errors unless it's configured
        if (this.settings.log4XXResponses) {
            if (error instanceof Errors.MoleculerError && !_.inRange(error.code, 400, 500)) {
                this.logger.error(
                    '   Request error!',
                    error.name,
                    ':',
                    error.message,
                    '\n',
                    error.stack,
                    '\nData:',
                    error.data,
                );
            }
        }
        this.sendError(req, res, error);
    }

    private handle = (req: IncomingMessage, res: ServerResponse) => {
        void this.dispatch(req, res);
    };

    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // Set pointers to service
        req.$startTime = process.hrtime();

        res.locals = res.locals || {};
        req.originalUrl = req.url;

        const parsed = parseRequestURL(req);
        const hasTrailingSlash = parsed.url.length > 1 && parsed.url.endsWith('/');
        let url = parsed.url;

        // Trim trailing slash
        if (hasTrailingSlash) {
            url = url.slice(0, -1);
        }

        req.parsedUrl = url;

        if (!req.query) {
            req.query = parsed.query;
        }

        this.logRequest(req);

        const mount = this.resolveMount(url);
        const request: ServerRequest = { req, res, path: url, url, query: parsed.query };

        if (!mount) {
            await this.run(this.fallback, request);
            return;
        }

        const search = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

        if (mount.slashRedirect && url === mount.prefix && !hasTrailingSlash) {
            res.writeHead(307, { location: `${mount.prefix}/${search}` });
            res.end();
            return;
        }

        if (mount.mode === 'prefix') {
            const rest = url.slice(mount.prefix.length);
            request.path = rest === '' ? '/' : rest;
            req.baseUrl = mount.prefix;
            req.url = `${request.path}${search}`;
        }

        await this.run(mount.handler, request);
    }

    private resolveMount(url: string): Mount | undefined {
        let match: Mount | undefined;

        for (const mount of this.mounts) {
            const matches =
                mount.mode === 'exact'
                    ? url === mount.prefix
                    : url === mount.prefix || url.startsWith(`${mount.prefix}/`);

            if (matches && (!match || mount.prefix.length > match.prefix.length)) {
                match = mount;
            }
        }

        return match;
    }

    private async run(handler: RequestHandler, request: ServerRequest): Promise<void> {
        try {
            await handler(request);
        } catch (error: unknown) {
            this.errorHandler(request.req, request.res, error);
        }
    }

    private reformatError(error: ErrorsType.MoleculerError) {
        return _.pick(error, ['name', 'message', 'code', 'type', 'data', 'stack']);
    }

    private logRequest(req: IncomingMessage): void {
        if (!this.settings.logging) {
            return;
        }

        if (this.settings.logRequest && this.settings.logRequest in this.logger) {
            this.logger[this.settings.logRequest](`=> ${req.method} ${req.originalUrl}`);
        }
    }

    private logResponse(req: IncomingMessage, res: ServerResponse, data?: unknown): void {
        let time = '';
        if (req.$startTime) {
            const diff = process.hrtime(req.$startTime);
            const duration = (diff[0] + diff[1] / 1e9) * 1000;
            if (duration > 1000) {
                time = kleur.red(`[+${Number(duration / 1000).toFixed(3)} s]`);
            } else {
                time = kleur.grey(`[+${Number(duration).toFixed(3)} ms]`);
            }
        }

        if (this.settings.logResponse && this.settings.logResponse in this.logger)
            this.logger[this.settings.logResponse](
                `<= ${this.coloringStatusCode(res.statusCode)} ${req.method} ${kleur.bold(
                    req.originalUrl ?? '',
                )} ${time}`,
            );

        if (this.settings.logResponseData && this.settings.logResponseData in this.logger) {
            this.logger[this.settings.logResponseData]('  Data:', data);
        }
    }

    private coloringStatusCode(code: number) {
        if (code >= 500) return kleur.red().bold(code);
        if (code >= 400 && code < 500) return kleur.red().bold(code);
        if (code >= 300 && code < 400) return kleur.cyan().bold(code);
        if (code >= 200 && code < 300) return kleur.green().bold(code);

        return code;
    }
}

function normalizePrefix(prefix: string): string {
    const trimmed = prefix.replace(/\/+$/, '');
    if (trimmed === '') {
        return '';
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
