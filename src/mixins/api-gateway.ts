import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import Stream, { PassThrough } from 'node:stream';
import bodyParser, { type BodyParser } from 'body-parser';
import { isStream } from 'is-stream';
import kleur from 'kleur';
import _ from 'lodash';
import { action, created, method, service, started, stopped } from 'moldecor';
import {
    type CallingOptions,
    type Context,
    Errors,
    type Logger,
    Service as MoleculerService,
} from 'moleculer';
import { is } from 'type-is';
import {
    convert1CErrorToMoleculerError,
    convertToMoleculerError,
    isMoleculerError,
    MethodNotAllowed,
    NotFoundError,
    RequestRejectedError,
    RequestTimeoutError,
    ServiceUnavailableError,
    UnsupportedMediaType,
} from '../errors.js';
import Packet from '../packet.js';
import type { AuthInfo, ConnectionInfo, IncomingMessage, ServerResponse } from '../types.js';
import { buildUrl, parseRequestURL } from '../utils/utils.js';

interface Settings {
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
    path: string;
    //
    logging: boolean;
    // Log each request (default to "info" level)
    logRequest: keyof Logger | null;
    // Log the request ctx.params (default to "debug" level)
    logRequestParams: keyof Logger | null;
    // Log each response (default to "info" level)
    logResponse: keyof Logger | null;
    // Log the response data (default to disable)
    logResponseData: keyof Logger | null;
    // If set to true, it will log 4xx client errors, as well
    log4XXResponses: boolean;
}

interface RestParams {
    req: IncomingMessage;
    res: ServerResponse;
}

@service({
    name: 'api-gateway',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    settings: {
        // Exposed port
        port: Number(process.env.PORT) || 5103,

        // Exposed IP
        ip: process.env.IP || '0.0.0.0',

        // Sidecar path
        path: '/sidecar',

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
    },
})
export default class ApiGateway extends MoleculerService<Settings> {
    private server!: http.Server | http2.Http2Server;
    private isHTTPS!: boolean;

    private jsonParser!: ReturnType<BodyParser['json']>;

    protected authorize?: (ctx: Context, req: IncomingMessage) => void;
    protected request?: (ctx: Context) => void;

    @action({
        name: 'rest',
        params: {
            req: 'object',
            res: 'object',
        },
        visibility: 'private',
        tracing: {
            tags: {
                params: ['req.url', 'req.method'],
            },
            spanName: (ctx) => {
                const { req } = (ctx as Context<RestParams>).params;
                return `${req.method} ${req.url}`;
            },
        },
        timeout: 0,
    })
    protected rest(ctx: Context<RestParams>) {
        const req = ctx.params.req;
        const res = ctx.params.res;

        // Set pointers to Context
        req.$ctx = ctx;
        res.$ctx = ctx;

        return new this.Promise<void | boolean>(async (resolve, reject) => {
            res.once('finish', () => resolve(true));
            res.once('close', () => resolve(true));
            res.once('error', (err: Error) => reject(err));

            try {
                // Authorization
                await this.authorize?.call(this, ctx, req);

                const packet = await this.parseRequestBody(req, res);

                const context = packet.toContext(this.broker, ctx);

                context.broker = ctx.broker;

                const data = await this.request?.(context);

                // Send back the response
                this.sendResponse(req, res, data);

                return resolve(true);
            } catch (err) {
                return reject(err);
            }
        });
    }

    @method
    protected async send<R>(
        ctx: Context<unknown, object, { connection: ConnectionInfo & AuthInfo }>,
    ): Promise<R> {
        // Create an AbortController to handle timeout.
        const controller = new AbortController();
        const { signal } = controller;
        const timer =
            ctx.options.timeout &&
            setTimeout(() => {
                controller.abort();
            }, ctx.options.timeout);

        let url;
        let response;
        try {
            const connection = ctx.locals.connection;
            // @ts-expect-error
            delete ctx.locals.connection;

            // Validate the URL to catch invalid URL errors early
            url = buildUrl(connection);

            const headers = new Headers();
            if (connection.auth) {
                if ('token' in connection.auth) {
                    headers.set('Authorization', `Bearer ${connection.auth.token}`);
                }
            }

            const { body, contentType } = await this.createRequestBody(ctx);
            headers.set('content-type', contentType);

            // Start the fetch request with the abort signal.
            console.log(body);
            response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                duplex: 'half',
                signal,
            });

            // Clear the timeout once the request completes.
            timer && clearTimeout(timer);
        } catch (error) {
            console.log(error);
            if (error instanceof Error) {
                // Handle a request abort (timeout)
                if (error.name === 'AbortError') {
                    throw new RequestTimeoutError(url, error);
                }
            } else if (error instanceof TypeError) {
                // Handle invalid URL or incorrect fetch usage
                throw new RequestRejectedError(url, error);
            }
            throw convertToMoleculerError(error);
        }

        if (!response.ok) {
            return (await this.responseErrorHandler(response)) as R;
        }
        const packet = await this.parseResponseBody(response);
        ctx.nodeID = packet.sender;
        Object.assign(ctx.meta || {}, packet!.meta || {});
        if (packet.stream) {
            return packet.stream as R;
        }
        return packet.data as R;
    }

    @method
    private async parseRequestBody(req: IncomingMessage, res: ServerResponse) {
        switch (is(req.headers['content-type'] ?? '', ['json', 'multipart'])) {
            case 'json': {
                await new Promise((resolve) => this.jsonParser(req as any, res as any, resolve));
                const { data, sender, meta, stream } = req.body;
                return new Packet(data, sender, stream, meta);
            }
            case 'multipart': {
                return Packet.fromMultipart(req.headers, req);
            }
            default: {
                throw new UnsupportedMediaType();
            }
        }
    }

    @method
    private async parseResponseBody(response: Response) {
        const contentType = response.headers.get('content-type') ?? '';
        switch (is(contentType, ['json', 'multipart'])) {
            case 'json': {
                return Packet.fromJSON(await response.text());
            }
            case 'multipart': {
                return Packet.fromMultipart(response.headers, response.body!);
            }
            default: {
                throw new UnsupportedMediaType('MALFORMED_RESPONSE', await response.text());
            }
        }
    }

    @method
    private async createRequestBody(ctx: Context) {
        const packet = Packet.fromContext(ctx);
        let contentType = 'application/json';
        let body;
        if (packet.stream) {
            const formData = await packet.toFormData();
            contentType = formData.getHeaders()['content-type'];
            body = new PassThrough();
            formData.pipe(body);
        } else {
            body = packet.toJSON();
        }
        return {
            body,
            contentType,
        };
    }

    /**
     * Convert data & send back to client
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {any} data
     * @param {Object?} action
     */
    @method
    private async sendResponse(req: IncomingMessage, res: ServerResponse, data: unknown) {
        if (res.headersSent) {
            this.logger.warn('Headers have already sent.', { url: req.url });
            return;
        }

        if (!res.statusCode) {
            res.statusCode = 200;
        }

        const ctx = req.$ctx!;

        const _isStream =
            Buffer.isBuffer(data) ||
            (_.isObject(data) && (data as any).type == 'Buffer') ||
            isStream(data);
        const packet = new Packet(
            _isStream ? null : data,
            ctx.nodeID,
            _isStream ? data : (false as any),
            ctx.meta,
        );

        if (packet.stream === false) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.end(packet.toJSON());
        }

        const formData = await packet.toFormData();
        res.writeHead(200, formData.getHeaders());
        return formData.pipe(res);
    }

    /**
     * Encode response data
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {any} data
     */
    @method
    private encodeResponse(req: IncomingMessage, res: ServerResponse, data: unknown) {
        return JSON.stringify(data);
    }

    /**
     * HTTP request handler. It is called from native NodeJS HTTP server.
     */
    @method
    private async httpHandler(req: IncomingMessage, res: ServerResponse) {
        // Set pointers to service
        req.$startTime = process.hrtime();

        res.locals = res.locals || {};
        req.originalUrl = req.url;

        const parsed = parseRequestURL(req);
        let url = parsed.url;

        // Trim trailing slash
        if (url.length > 1 && url.endsWith('/')) {
            url = url.slice(0, -1);
        }

        req.parsedUrl = url;

        if (!req.query) {
            req.query = parsed.query;
        }

        this.logRequest(req);

        // Prevent connection to any other endpoints
        if (req.method !== 'POST') {
            return this.sendError(req, res, new MethodNotAllowed());
        }
        if (req.parsedUrl !== this.settings.path) {
            return this.send404(req, res);
        }

        const options: CallingOptions = {};
        try {
            await this.actions.rest({ req, res }, options);
        } catch (error: unknown) {
            this.errorHandler(req, res, error);
        }
    }

    /**
     * Send 404 response
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     */
    @method
    private send404(req: IncomingMessage, res: ServerResponse) {
        this.sendError(req, res, new NotFoundError());
    }

    @method
    private errorHandler(req: IncomingMessage, res: ServerResponse, error: unknown) {
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

    @method
    private async responseErrorHandler(response: Response) {
        const contentType = response.headers.get('content-type');
        if (!contentType) {
            throw new Errors.MoleculerError(
                response.statusText,
                response.status,
                response.statusText,
            );
        }
        switch (is(contentType, ['json', 'xml'])) {
            case 'json': {
                const errorObject = await response.json();
                const error = convertToMoleculerError(errorObject);
                throw error;
            }
            case 'xml': {
                // Handle 1C error
                const xmlText = await response.text();
                const error = await convert1CErrorToMoleculerError(response, xmlText);
                throw error;
            }
            default: {
                const responseText = await response.text();
                throw new Errors.MoleculerError(responseText, response.status, response.statusText);
            }
        }
    }

    /**
     * Send an error response
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {Error} err
     */
    @method
    private sendError(req: IncomingMessage, res: ServerResponse, error: unknown) {
        if (res.headersSent) {
            this.logger.warn('Headers have already sent', req.url, error);
            return undefined;
        }

        if (!error || !(error instanceof Error)) {
            res.writeHead(500);
            res.end('Internal Server Error');

            this.logResponse(req, res);
            return undefined;
        }

        // Type guard
        if (!isMoleculerError(error)) {
            error = convertToMoleculerError(error);
            // MOOOOOORE TYPE GUARDS
            if (!isMoleculerError(error)) {
                res.writeHead(500);
                res.end('Internal Server Error');

                this.logResponse(req, res);
                return undefined;
            }
        }

        // Return with the error as JSON object
        res.setHeader('content-type', 'application/json; charset=utf-8');

        const code = _.isNumber(error.code) && _.inRange(error.code, 400, 599) ? error.code : 500;
        res.writeHead(code);
        const errObj = this.reformatError(error, req, res);
        res.end(errObj !== undefined ? this.encodeResponse(req, res, errObj) : '');

        this.logResponse(req, res);

        return undefined;
    }

    @method
    private reformatError(error: Errors.MoleculerError, req: IncomingMessage, res: ServerResponse) {
        return _.pick(error, ['name', 'message', 'code', 'type', 'data', 'stack']);
    }

    @method
    private logRequest(req: IncomingMessage) {
        if (!this.settings.logging) {
            return;
        }

        if (this.settings.logRequest && this.settings.logRequest in this.logger) {
            this.logger[this.settings.logRequest](`=> ${req.method} ${req.originalUrl}`);
        }
    }

    @method
    private logResponse(req: IncomingMessage, res: ServerResponse, data?: unknown) {
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

    @method
    private coloringStatusCode(code: number) {
        if (code >= 500) return kleur.red().bold(code);
        if (code >= 400 && code < 500) return kleur.red().bold(code);
        if (code >= 300 && code < 400) return kleur.cyan().bold(code);
        if (code >= 200 && code < 300) return kleur.green().bold(code);

        return code;
    }

    @method
    private createServer() {
        if (this.server) {
            return;
        }

        this.isHTTPS = false;
        if (this.settings.https && this.settings.https.key && this.settings.https.cert) {
            if (this.settings.http2) {
                this.server = http2.createSecureServer(
                    this.settings.https,
                    this.httpHandler as unknown as Parameters<typeof http2.createSecureServer>[1],
                );
                this.isHTTPS = true;
            } else {
                this.server = https.createServer(
                    this.settings.https,
                    this.httpHandler as unknown as Parameters<typeof https.createServer>[1],
                );
            }
        } else {
            if (this.settings.http2) {
                this.server = http2.createServer(
                    this.httpHandler as Parameters<typeof http2.createServer>[0],
                );
                this.isHTTPS = true;
            } else {
                this.server = http.createServer(
                    this.httpHandler as Parameters<typeof http.createServer>[0],
                );
            }
        }

        // HTTP server timeout
        // if (this.settings.httpServerTimeout) {
        //     this.logger.debug(
        //         'Override default http(s) server timeout:',
        //         this.settings.httpServerTimeout,
        //     );
        //     this.server.setTimeout(this.settings.httpServerTimeout);
        // }

        // if ('requestTimeout' in this.server) {
        //     this.server.requestTimeout = this.settings.requestTimeout;
        //     this.logger.debug(
        //         'Setting http(s) server request timeout to:',
        //         this.settings.requestTimeout,
        //     );
        // }
    }

    @created
    public created() {
        // Create a new HTTP/HTTPS/HTTP2 server instance
        this.createServer();
        this.server.on('error', (error: unknown) => {
            this.logger.error('Server error', error);
        });

        this.jsonParser = bodyParser.json();

        this.logger.info('Sidecar gateway server created.');
    }

    @started
    public started() {
        return new this.Promise<void>((resolve) => {
            this.server.listen(Number(this.settings.port), this.settings.ip, () => {
                const addr = this.server.address() as AddressInfo;
                const listenAddr =
                    addr.address == '0.0.0.0' && os.platform() == 'win32'
                        ? 'localhost'
                        : addr.address;
                this.logger.info(
                    `Sidecar gateway listening on ${
                        this.isHTTPS ? 'https' : 'http'
                    }://${listenAddr}:${addr.port}`,
                );
                resolve();
            });
        });
    }

    @stopped
    public stopped() {
        if (!this.server.listening) {
            return this.Promise.resolve();
        }
        return new this.Promise<void>((resolve, reject) => {
            this.server.close((error: unknown) => {
                if (error) {
                    return reject(error);
                }

                this.logger.info('Sidecar gateway stopped!');
                resolve();
            });
        });
    }
}
