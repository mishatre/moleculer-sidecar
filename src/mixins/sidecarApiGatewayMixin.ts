import bodyParser from 'body-parser';
import kleur from 'kleur';
import _ from 'lodash';
import {
    ActionEndpoint,
    ActionSchema,
    Context,
    Errors,
    GenericObject,
    LoggerInstance,
    Service as MoleculerService,
    ServiceSettingSchema,
} from 'moleculer';
import http from 'node:http';
import http2, { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import https from 'node:https';
import { AddressInfo } from 'node:net';
import os from 'node:os';

import {
    MoleculerAction as Action,
    MoleculerMethod as Method,
    MoleculerService as Service,
    MoleculerServiceCreated as ServiceCreated,
    MoleculerServiceStarted as ServiceStarted,
    MoleculerServiceStopped as ServiceStopped,
} from '../mol-decor';

type DefaultContext = Context<
    {
        req: IncomingMessage;
        res: ServerResponse;
    },
    {
        $responseType: string;
        $responseHeaders: Record<string, string>;
        $statusCode: number;
        $statusMessage: string;
        $location: string;
    }
>;

type IncomingRequestExt = {
    $startTime?: [number, number];
    $service?: SidecarApiGateway;
    $ctx?: DefaultContext;
    originalUrl?: string;
    body?: any;
};

type ServerResponseExt = {
    $ctx?: DefaultContext;
    locals?: any;
};

export type IncomingMessage = (Http2ServerRequest | http.IncomingMessage) & IncomingRequestExt;
type ServerResponse = (Http2ServerResponse | http.ServerResponse) & ServerResponseExt;

type ActionSchemaWithResponseHeaders = ActionSchema & { responseHeaders?: Record<string, string> };

interface SidecarApiGatewaySettings extends ServiceSettingSchema {
    port: number;
    // Exposed IP
    ip: string;
    // Log each request (default to "info" level)
    logRequest: keyof LoggerInstance | null;
    // Log the request ctx.params (default to "debug" level)
    logRequestParams: keyof LoggerInstance | null;
    // Log each response (default to "info" level)
    logResponse: keyof LoggerInstance | null;
    // Log the response data (default to disable)
    logResponseData: keyof LoggerInstance | null;
    // If set to true, it will log 4xx client errors, as well
    log4XXResponses: boolean;
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
    // Debounce wait time before call to regenerate aliases when received event "$services.changed"
    debounceTime: number;

    logging: boolean;
    authorization: boolean;
}

/**
 * Not found HTTP error
 *
 * @class NotFoundError
 * @extends {Error}
 */
class NotFoundError extends Errors.MoleculerError {
    /**
     * Creates an instance of NotFoundError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf NotFoundError
     */
    constructor(type?: string, data?: unknown) {
        super('Not found', 404, type || 'NOT_FOUND', data);
    }
}

/**
 * Service unavailable HTTP error
 *
 * @class ForbiddenError
 * @extends {Error}
 */
class ServiceUnavailableError extends Errors.MoleculerError {
    /**
     * Creates an instance of ForbiddenError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf ForbiddenError
     */
    constructor(type = '', data?: unknown) {
        super('Service unavailable', 503, type, data);
    }
}

function convertToMoleculerError(error: unknown): error is Errors.MoleculerError {
    if (!(error instanceof Errors.MoleculerError)) {
        const e = error as Errors.MoleculerError;
        const err = new Errors.MoleculerError(
            e.message,
            e.code || (e as any).status,
            e.type,
            e.data,
        );
        err.name = e.name;
        error = err;
    }
    return true;
}

@Service({
    name: 'sidecarApiGateway',
    settings: {
        // Exposed port
        port: Number(process.env.PORT) || 3000,

        // Exposed IP
        ip: process.env.IP || '0.0.0.0',

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

        // Use HTTPS
        https: false,

        // Use HTTP2 server (experimental)
        http2: false,

        // HTTP Server Timeout
        httpServerTimeout: null,

        // Request Timeout. More info: https://github.com/moleculerjs/moleculer-web/issues/206
        requestTimeout: 300000, // Sets node.js v18 default timeout: https://nodejs.org/api/http.html#serverrequesttimeout

        // Debounce wait time before call to regenerate aliases when received event "$services.changed"
        debounceTime: 500,

        logging: true,
        authorization: false,
    },
})
export default class SidecarApiGateway extends MoleculerService<SidecarApiGatewaySettings> {
    private parser = bodyParser.json();

    private server!: http.Server | http2.Http2Server;

    @Action({
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
                const { req } = (ctx as DefaultContext).params;
                return `${req.method} ${req.url}`;
            },
        },
        timeout: 0,
    })
    public rest(ctx: DefaultContext) {
        let req = ctx.params.req;
        const res = ctx.params.res;

        // Set pointers to Context
        req.$ctx = ctx;
        res.$ctx = ctx;

        let url = req.url ?? '';
        // Trim trailing slash
        if (url.length > 1 && url.endsWith('/')) {
            url = url.slice(0, -1);
        }

        if (req.method !== 'POST' || url !== '/v1/message') {
            return null;
        }

        this.logRequest(req);

        return new Promise(async (resolve, reject) => {
            res.once('finish', () => resolve(true));
            res.once('close', () => resolve(true));
            res.once('error', (error) => reject(error));

            try {
                await new Promise<void>((resolve, reject) => {
                    this.parser(
                        req as http.IncomingMessage,
                        res as http.ServerResponse,
                        (error) => {
                            if (error) {
                                reject(new Errors.MoleculerError(error));
                            } else {
                                resolve();
                            }
                        },
                    );
                });

                const params = _.isObject(req.body) ? req.body : {};

                // Authorization
                if (this.settings.authorization) {
                    await this.authorize.call(this, ctx, req, res);
                }

                // Logging params
                if (this.settings.logging) {
                    if (this.settings.logRequest && this.settings.logRequest in this.logger)
                        this.logger[this.settings.logRequest](
                            `   Call '$sidecar.incomingMessage' action`,
                        );
                    if (
                        this.settings.logRequestParams &&
                        this.settings.logRequestParams in this.logger
                    )
                        this.logger[this.settings.logRequestParams]('   Params:', params);
                }

                const opts = {
                    parentCtx: ctx,
                };

                // Call the action
                let data = await this.actions.incomingMessage(params, opts);
                const action = this.schema.actions!
                    .incomingMessage as ActionSchemaWithResponseHeaders;

                // Send back the response
                this.sendResponse(req, res, data, action);

                if (this.settings.logging) {
                    this.logResponse(req, res, data);
                }

                resolve(true);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Convert data & send back to client
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {any} data
     * @param {Object?} action
     */
    @Method
    private sendResponse(
        req: IncomingMessage,
        res: ServerResponse,
        data: unknown,
        action: ActionSchemaWithResponseHeaders,
    ) {
        const ctx = req.$ctx!;

        if (res.headersSent) {
            this.logger.warn('Headers have already sent.', { url: req.url, action });
            return;
        }

        if (!res.statusCode) {
            res.statusCode = 200;
        }

        // Status code & message
        if (ctx.meta.$statusCode) {
            res.statusCode = ctx.meta.$statusCode;
        }
        if (ctx.meta.$statusMessage) {
            res.statusMessage = ctx.meta.$statusMessage;
        }

        // Redirect
        if (
            res.statusCode == 201 ||
            (res.statusCode >= 300 && res.statusCode < 400 && res.statusCode !== 304)
        ) {
            const location = ctx.meta.$location;
            if (!location) {
                this.logger.warn(
                    `The 'ctx.meta.$location' is missing for status code '${res.statusCode}'!`,
                );
            } else {
                res.setHeader('Location', location);
            }
        }

        // Override responseType from action schema
        let responseType;
        if (action && action.responseType) {
            responseType = action.responseType;
        }

        // Custom headers from action schema
        if (action && action.responseHeaders) {
            for (const [key, value] of Object.entries(action.responseHeaders)) {
                res.setHeader(key, value);
                if (key == 'Content-Type' && !responseType) {
                    responseType = value;
                }
            }
        }

        // Custom responseType from ctx.meta
        if (ctx.meta.$responseType) {
            responseType = ctx.meta.$responseType;
        }

        // Custom headers from ctx.meta
        if (ctx.meta.$responseHeaders) {
            for (const [key, value] of Object.entries(ctx.meta.$responseHeaders)) {
                if (key == 'Content-Type' && !responseType) responseType = value;
                else {
                    try {
                        res.setHeader(key, value);
                    } catch (error) {
                        this.logger.warn('Invalid header value', req.url, error);
                        res.setHeader(key, encodeURI(value));
                    }
                }
            }
        }

        if (data == null) {
            return res.end();
        }

        let chunk;
        // // Buffer
        // if (Buffer.isBuffer(data)) {
        //     res.setHeader("Content-Type", responseType || "application/octet-stream");
        //     res.setHeader("Content-Length", data.length);
        //     chunk = data;
        // }
        // Buffer from Object
        // else if (_.isObject(data) && data.type == "Buffer") {
        //     const buf = Buffer.from(data);
        //     res.setHeader("Content-Type", responseType || "application/octet-stream");
        //     res.setHeader("Content-Length", buf.length);
        //     chunk = buf;
        // }
        // // Stream
        // else if (isReadableStream(data)) {
        //     res.setHeader("Content-Type", responseType || "application/octet-stream");
        //     chunk = data;
        // }
        // Object or Array (stringify)
        if (_.isObject(data) || Array.isArray(data)) {
            res.setHeader('Content-Type', responseType || 'application/json; charset=utf-8');
            chunk = this.encodeResponse(req, res, data);
        }
        // Other (stringify or raw text)
        else {
            if (!responseType) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                chunk = this.encodeResponse(req, res, data);
            } else {
                res.setHeader('Content-Type', responseType);
                if (_.isString(data)) chunk = data;
                else chunk = data.toString();
            }
        }

        // // Auto generate & add ETag
        // if (route.etag && chunk && !res.getHeader("ETag") && !isReadableStream(chunk)) {
        //     res.setHeader("ETag", generateETag.call(this, chunk, route.etag));
        // }

        // Freshness
        // if (isFresh(req, res))
        //     res.statusCode = 304;

        if (res.statusCode === 204 || res.statusCode === 304) {
            res.removeHeader('Content-Type');
            res.removeHeader('Content-Length');
            res.removeHeader('Transfer-Encoding');

            chunk = '';
        }

        if (req.method === 'HEAD') {
            // skip body for HEAD
            res.end();
        } else {
            // respond
            // if (isReadableStream(data)) { //Stream response
            //     pipeline(data, res, err => {
            //         if (err) {
            //             this.logger.warn("Stream got an error.", { err, url: req.url, actionName: action.name })
            //         }
            //     })
            // } else {
            res.end(chunk);
            // }
        }

        return;
    }

    /**
     * HTTP request handler. It is called from native NodeJS HTTP server.
     */
    @Method
    private async httpHandler(req: IncomingMessage, res: ServerResponse) {
        // Set pointers to service
        req.$startTime = process.hrtime();
        req.$service = this;

        res.locals = res.locals || {};

        req.originalUrl = req.url;

        let options: GenericObject = {};

        let span;
        if (req.headers['x-trace-id']) {
            const parentSpan = {
                traceID: req.headers['x-trace-id'] as string,
                parentID: req.headers['x-trace-parent-id'] as string,
                sampled: true,
            };
            span = this.broker.tracer.startSpan(req.headers['x-trace-span-name'] as string, {
                parentSpan,
            });
            options.parentSpan = parentSpan;
        }

        try {
            const result = await this.actions.rest({ req, res }, options);
            if (result === null) {
                // Not routed
                this.send404(req, res);
            }
        } catch (error: unknown) {
            this.errorHandler(req, res, error);
        } finally {
            span?.finish();
        }
    }

    @Method
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

    /**
     * Send 404 response
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     */
    @Method
    private send404(req: IncomingMessage, res: ServerResponse) {
        this.sendError(req, res, new NotFoundError());
    }

    /**
     * Send an error response
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {Error} err
     */
    @Method
    private sendError(req: IncomingMessage, res: ServerResponse, error: unknown) {
        // // Global error handler
        // if (_.isFunction(this.settings.onError))
        // 	return this.settings.onError.call(this, req, res, err);

        // --- Default error handler

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
        if (!convertToMoleculerError(error)) {
            return;
        }

        const ctx = req.$ctx;
        let responseType = 'application/json; charset=utf-8';

        if (ctx) {
            if (ctx.meta.$responseType) {
                responseType = ctx.meta.$responseType;
            }
            if (ctx.meta.$responseHeaders) {
                for (const [key, value] of Object.entries(ctx.meta.$responseHeaders)) {
                    if (key === 'Content-Type' && !responseType) responseType = value;
                    else {
                        try {
                            res.setHeader(key, value);
                        } catch (error) {
                            this.logger.warn('Invalid header value', req.url, error);
                            res.setHeader(key, encodeURI(value));
                        }
                    }
                }
            }
        }

        // Return with the error as JSON object
        res.setHeader('content-type', responseType);

        const code = _.isNumber(error.code) && _.inRange(error.code, 400, 599) ? error.code : 500;
        res.writeHead(code);
        const errObj = this.reformatError(error, req, res);
        res.end(errObj !== undefined ? this.encodeResponse(req, res, errObj) : '');

        this.logResponse(req, res);
    }

    /**
     * Encode response data
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {any} data
     */
    @Method
    private encodeResponse(req: IncomingMessage, res: ServerResponse, data: unknown) {
        return JSON.stringify(data);
    }

    @Method
    private reformatError(error: Errors.MoleculerError, req: IncomingMessage, res: ServerResponse) {
        return _.pick(error, ['name', 'message', 'code', 'type', 'data']);
    }

    /**
     * Log the request
     *
     * @param {HttpIncomingMessage} req
     */
    @Method
    private logRequest(req: IncomingMessage) {
        if (!this.settings.logging) {
            return;
        }

        if (this.settings.logRequest && this.settings.logRequest in this.logger) {
            this.logger[this.settings.logRequest](`=> ${req.method} ${req.originalUrl}`);
        }
    }

    /**
     * Log the response
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {any} data
     */
    @Method
    private logResponse(req: IncomingMessage, res: ServerResponse, data?: unknown) {
        // if (req.$route && !req.$route.logging) return;

        let time = '';
        if (req.$startTime) {
            const diff = process.hrtime(req.$startTime);
            const duration = (diff[0] + diff[1] / 1e9) * 1000;
            if (duration > 1000) time = kleur.red(`[+${Number(duration / 1000).toFixed(3)} s]`);
            else time = kleur.grey(`[+${Number(duration).toFixed(3)} ms]`);
        }

        if (this.settings.logResponse && this.settings.logResponse in this.logger)
            this.logger[this.settings.logResponse](
                `<= ${this.coloringStatusCode(res.statusCode)} ${req.method} ${kleur.bold(req.originalUrl ?? '')} ${time}`,
            );

        if (this.settings.logResponseData && this.settings.logResponseData in this.logger) {
            this.logger[this.settings.logResponseData]('  Data:', data);
        }
    }

    /**
     * Return with colored status code
     *
     * @param {any} code
     * @returns
     */
    @Method
    private coloringStatusCode(code: number) {
        if (code >= 500) return kleur.red().bold(code);
        if (code >= 400 && code < 500) return kleur.red().bold(code);
        if (code >= 300 && code < 400) return kleur.cyan().bold(code);
        if (code >= 200 && code < 300) return kleur.green().bold(code);

        return code;
    }

    /**
     * Create HTTP server
     */
    @Method
    private createServer() {
        if (this.server) {
            return;
        }

        if (this.settings.https && this.settings.https.key && this.settings.https.cert) {
            if (this.settings.http2) {
                this.server = http2.createSecureServer(this.settings.https, this.httpHandler);
            } else {
                this.server = https.createServer(this.settings.https, this.httpHandler);
            }
            this.isHTTPS = true;
        } else {
            if (this.settings.http2) {
                this.server = http2.createServer(this.httpHandler);
            } else {
                this.server = http.createServer(this.httpHandler);
            }
            this.isHTTPS = false;
        }

        // HTTP server timeout
        if (this.settings.httpServerTimeout) {
            this.logger.debug(
                'Override default http(s) server timeout:',
                this.settings.httpServerTimeout,
            );
            this.server.setTimeout(this.settings.httpServerTimeout);
        }

        if ('requestTimeout' in this.server) {
            this.server.requestTimeout = this.settings.requestTimeout;
            this.logger.debug(
                'Setting http(s) server request timeout to:',
                this.settings.requestTimeout,
            );
        }
    }

    /**
     * Service created lifecycle event handler
     */
    @ServiceCreated
    protected created() {
        // Create a new HTTP/HTTPS/HTTP2 server instance
        this.createServer();

        this.server.on('error', (error: unknown) => {
            this.logger.error('Server error', error);
        });

        this.parser = bodyParser.json();

        this.logger.info('Sidecar gateway server created.');
    }

    /**
     * Service started lifecycle event handler
     */
    @ServiceStarted
    protected started() {
        return new Promise<void>((resolve) => {
            this.server.listen(this.settings.port, this.settings.ip, () => {
                const addr = this.server.address() as AddressInfo;
                const listenAddr =
                    addr.address == '0.0.0.0' && os.platform() == 'win32'
                        ? 'localhost'
                        : addr.address;
                this.logger.info(
                    `Sidecar gateway listening on ${this.isHTTPS ? 'https' : 'http'}://${listenAddr}:${addr.port}`,
                );
                resolve();
            });
        });
    }

    /**
     * Service stopped lifecycle event handler
     */
    @ServiceStopped
    protected stopped() {
        if (!this.server.listening) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            this.server.close((error: unknown) => {
                if (error) return reject(error);

                this.logger.info('Sidecar gateway stopped!');
                resolve();
            });
        });
    }
}
