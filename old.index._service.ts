import http from 'node:http';
import http2, { type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path/posix';
import type Stream from 'node:stream';
import { PassThrough, Readable } from 'node:stream';
import { Busboy } from '@fastify/busboy';
import bodyParser, { type BodyParser } from 'body-parser';
import FormData from 'form-data';
import { isStream } from 'is-stream';
import kleur from 'kleur';
import _ from 'lodash';
import { action, created, method, service, started, stopped } from 'moldecor';
import {
    type ActionSchema,
    type CallingOptions,
    type Context,
    type Endpoint,
    Errors,
    type Logger,
    Service as MoleculerService,
    type ServiceSchema,
} from 'moleculer';
import DbService from 'moleculer-db';
import SqlAdapter from 'moleculer-db-adapter-sequelize';
import Sequelize from 'sequelize';
import typeis, { is } from 'type-is';
import { parseStringPromise } from 'xml2js';
import { parse, stringify } from 'yaml';
import { parseReqSigV4, validateMessage } from './aws-signature.js';
import {
    convertToMoleculerError,
    ERR_INVALID_TOKEN,
    ERR_NO_TOKEN,
    MethodNotAllowed,
    NotFoundError,
    RequestRejectedError,
    RequestTimeoutError,
    ServiceUnavailableError,
    UnAuthorizedError,
    UnsupportedMediaType,
} from './errors.js';

type IncomingRequestExt = {
    $startTime?: [number, number];
    $service?: SidecarService;
    $ctx?: Context<RestParams, RestMeta>;
    baseUrl?: string;
    originalUrl?: string;
    parsedUrl?: string;
    body?: any;
    query?: Record<string, string | string[] | number | number[] | boolean | boolean[]>;
    $endpoint: Endpoint;
    $action: ActionSchema;
    $params: Record<string, unknown>;
};

type ServerResponseExt = {
    $ctx?: Context<RestParams, RestMeta>;
    locals?: any;
};

export type IncomingMessage = (Http2ServerRequest | http.IncomingMessage) & IncomingRequestExt;
export type ServerResponse = (Http2ServerResponse | http.ServerResponse) & ServerResponseExt;

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

interface RestMeta {
    $responseType: string;
    $responseHeaders: Record<string, string>;
    $statusCode: number;
    $statusMessage: string;
    $location: string;

    user: unknown;
}

export function parseRequestURL(req: { url?: string }) {
    const url = new URL(req.url!, 'https://example.com');
    return {
        url: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
    };
}

async function convert1CErrorToMoleculerError(response: Response, errorText: string) {
    const xmlData = await parseStringPromise(errorText);
    const errorDescription = xmlData.exception.descr[0]._;
    const errorStack = xmlData.exception.creationStack[0]._;
    const error = new Errors.MoleculerError(errorDescription, response.status, response.statusText);
    error.stack = errorStack;

    return error;
}

async function handleErrorResponse(response: Response) {
    const contentType = response.headers.get('content-type');
    if (!contentType) {
        throw new Errors.MoleculerError(response.statusText, response.status, response.statusText);
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

interface IBucket<T> extends AsyncGenerator<T, never, unknown> {
    push(v: T): void;
}

/**
 * A bucket is used to convert any asynchronously occurring event into an async generator.
 *
 * ```ts
 * const bucket = new Bucket<number>();
 *
 * setInterval(() => {
 *   bucket.push(Date.now());
 * }, 1000);
 *
 * for await (const timeStamp of bucket) {
 *   console.log(timeStamp);
 * }
 * ```
 */
export class Bucket<T> implements IBucket<T> {
    private stack: T[];
    private nextValue: ((v: T) => void) | null;
    private iterator: IBucket<T>;
    constructor() {
        this.stack = [];
        this.nextValue = null;

        const self = this;

        async function* bucket() {
            while (true) {
                yield new Promise((resolve: (v: T | undefined) => void) => {
                    if (self.stack.length > 0) {
                        return resolve(self.stack.shift());
                    }
                    self.nextValue = resolve;
                });
            }
        }

        this.iterator = bucket() as IBucket<T>;
    }

    push(value: T) {
        if (this.nextValue) {
            this.nextValue(value);
            this.nextValue = null;
            return;
        }

        this.stack.push(value);
    }
    [Symbol.iterator]() {
        // Typescript freaks out if this isn't here....
        // Even though Symbol.asyncIterator is present
        // and even though Symbol.iterator returns an async iterator
        return this;
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    next() {
        return this.iterator.next();
    }
    return(value: PromiseLike<never>) {
        return this.iterator.return(value);
    }
    throw(e: any) {
        return this.iterator.throw(e);
    }
}

interface Packet {
    data: unknown;
    sender: string;
    stream: Stream | boolean;
    meta: Record<any, any>;
}

async function packetToFormData(packet: Packet) {
    const stream = packet.stream;
    packet.stream = true;

    const formData = new FormData();
    formData.append('packet', Buffer.from(JSON.stringify(packet)), {
        contentType: 'application/json',
        filename: 'packet',
    });

    //const file = new File([buffer], 'stream', { type: 'application/octet-stream' });
    formData.append('stream', Buffer.concat(await Array.fromAsync(stream as any)), {
        contentType: 'application/octet-stream',
        filename: 'stream',
    });

    return formData;
}

async function handleResponse(response: Response, ctx: Context): Promise<Packet> {
    const contentType = response.headers.get('content-type');
    const cType = is(contentType!, ['json', 'multipart']);
    if (cType === 'json') {
        try {
            return (await response.json()) as Packet;
        } catch (error) {
            throw 'malformed response';
        }
    } else if (cType === 'multipart') {
        const busboy = new Busboy({
            headers: {
                'content-type': contentType!,
            },
        });
        const bucket = new Bucket<any>();
        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
            bucket.push({ fieldname, file, filename, encoding, mimetype });
        });
        busboy.on('finish', () => {
            console.log('Done parsing form!');
        });
        Readable.fromWeb(response.body!).pipe(busboy);

        let packet: Packet;
        for await (const { fieldname, file } of bucket) {
            if (fieldname === 'packet') {
                const buffer = Buffer.concat(await Array.fromAsync(file));
                packet = JSON.parse(buffer.toString('utf8'));
            } else if (fieldname === 'stream') {
                packet!.stream = new PassThrough();
                file.pipe(packet!.stream);
                break;
            }
        }
        if (!packet!) {
            throw 'malformed response';
        }

        return packet;
    }

    const packet = await response.text();
    console.log(packet);
    throw 'malformed response';
}

interface ConnectionInfo {
    id: string;
    endpoint: string;
    port: string;
    useSSL: boolean;
    path: string;
}

interface AuthInfo {
    auth:
        | { token: string }
        | {
              username: string;
              password: string;
          };
}

interface RegisterParams {
    connection: ConnectionInfo & AuthInfo;
    handler: string;
}

interface RemoteCallParams {
    connection: ConnectionInfo & AuthInfo;
    handler: string;
}

function buildUrl(connection: ConnectionInfo) {
    const url = new URL('https://example.org');
    url.protocol = connection.useSSL ? 'https' : 'http';
    url.port = connection.port;
    url.hostname = connection.endpoint;
    url.pathname = join(connection.path ?? '', 'hs/moleculer/sidecar');

    return url;
}

@service({
    name: '$sidecar',

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

    mixins: [DbService],
    adapter: new SqlAdapter({
        dialect: 'sqlite',
        storage: './.data/publication.sqlite',
        logging: false,
    }),

    model: {
        name: 'publication',
        define: {
            id: Sequelize.STRING,
            endpoint: Sequelize.STRING,
            port: Sequelize.STRING,
            useSSL: Sequelize.BOOLEAN,
            path: Sequelize.STRING,
            authType: Sequelize.ENUM('1', '2', '3'),
            username: Sequelize.STRING,
            password: Sequelize.STRING,
        },
        options: {
            // Options from http://docs.sequelizejs.com/manual/tutorial/models-definition.html
        },
    },

    // Disable all moleculer-db actions
    actions: {
        find: false,
        count: false,
        list: false,
        create: false,
        insert: false,
        get: false,
        update: false,
        remove: false,
    },
})
export default class SidecarService extends MoleculerService<Settings> {
    private adapter!: SqlAdapter & { db: Sequelize.Sequelize };
    declare private server: http.Server | http2.Http2Server;
    declare private isHTTPS;

    declare private jsonParser: ReturnType<BodyParser['json']>;

    @action({
        name: 'parseYAML',
        params: {
            string: 'string',
        },
    })
    public parseYAML(ctx: Context<{ string: string }>) {
        return parse(ctx.params.string);
    }

    @action({
        name: 'info',
    })
    public async info(ctx: Context<any>) {
        ctx.meta['arrra'] = 1;
        const response = await this.sendRequest(ctx);
        return response;
        console.log('HERE');
        throw new Error('123');
        return ctx.stream;
        // throw new Error('123');
    }

    @action({
        name: 'register',
        params: {
            connection: {},
            handler: 'string',
        },
    })
    public async register(ctx: Context<RegisterParams>) {
        const { connection } = ctx.params;

        ctx.locals = {
            ...ctx.locals,
            ...ctx.params,
        };
        const response = await this.sendRequest(ctx);

        for (const svc of response) {
            const serviceSchema = this.convertSidecarService(svc, connection);
            serviceSchema.metadata['$publication'] = connection.id;
            this.logger.info(
                kleur.yellow().bold(`Register new '${serviceSchema.name}' service...`),
            );
            this.broker.createService(serviceSchema);
        }

        await this.saveConnection(connection);

        return null;
    }

    private saveConnection({ auth, ...connection }: ConnectionInfo & AuthInfo) {
        return this.adapter.insert({
            ...connection,
            authType: !auth ? '' : 'token' in auth ? '' : '',
            username: 'username' in auth ? auth.username : undefined,
            password: 'token' in auth ? auth.token : auth.password,
        });
    }

    private convertSidecarService(service: ServiceSchema, connection: any) {
        const schema = _.cloneDeep(service);

        // Convert the schema, fulfill the action/event handlers
        if (schema.created) {
            schema.created = function handler() {
                // self.sendRequestToNode(ctx, node, "lifecycle", {
                //     event: {
                //         name: "created",
                //         handler: originalSchema.created
                //     }
                // });
            };
        }

        if (schema.started) {
            schema.started = function handler() {
                // return self.sendRequestToNode(ctx, node, "lifecycle", {
                //     event: {
                //         name: "started",
                //         handler: originalSchema.started
                //     }
                // });
            };
        }

        if (schema.stopped) {
            schema.stopped = function handler() {
                // return self.sendRequestToNode(ctx, node, "lifecycle", {
                //     event: {
                //         name: "stopped",
                //         handler: originalSchema.stopped
                //     }
                // });
            };
        }

        if (schema.actions) {
            for (const [actionName, action] of Object.entries(schema.actions)) {
                if (typeof action === 'boolean' || typeof action === 'function') {
                    continue;
                }
                const newAction = _.cloneDeep(action);
                newAction.handler = (ctx: Context) => {
                    ctx.locals = {
                        handler: action.handler,
                        connection,
                    };
                    return this.sendRequest(ctx);
                };
                schema.actions[actionName] = newAction;
            }
        }

        if (schema.events) {
            for (const [eventName, event] of Object.entries(schema.events)) {
                if (typeof event === 'function') {
                    continue;
                }
                const newEvent = _.cloneDeep(event);
                newEvent.handler = (ctx: Context) => {
                    ctx.locals = {
                        handler: event.handler,
                        connection,
                    };
                    return this.sendRequest(ctx) as any;
                };
                schema.events[eventName] = newEvent;
            }
        }

        // if (schema.channels) {
        //     for (const [channelName, channel] of Object.entries(schema.channels) as [
        //         string,
        //         Channel,
        //     ][]) {
        //         if (typeof channel === 'function') {
        //             continue;
        //         }
        //         let newChannel = _.cloneDeep(channel);
        //         newChannel.handler = (ctx: Context, raw: unknown) => {
        //             ctx.locals = {
        //                 handler: channel.handler,
        //                 gateway,
        //             };
        //             return this.sidecar.transit.sendChannelEvent(ctx, raw);
        //         };
        //         schema.channels[channelName] = newChannel;
        //     }
        // }

        schema.hooks = {};

        return schema;
    }

    @action({
        name: 'unregister',
    })
    public async unregister(ctx: Context<any>) {
        const services = this.broker.registry.services.list({
            onlyLocal: true,
            skipInternal: true,
            grouping: true,
        });
        for (const service of services) {
            if (service.metadata.$publication !== ctx.params.id) {
                continue;
            }
            this.logger.info(kleur.yellow().bold(`Destroying '${service.fullName}' service`));
            this.broker.destroyService(service.fullName);
        }
    }

    @action({
        name: 'remoteCall',
        params: {
            connection: {},
            handler: 'string',
        },
    })
    public remoteCall(ctx: Context<RemoteCallParams>) {
        ctx.locals = {
            ...ctx.locals,
            ...ctx.params,
        };
        return this.sendRequest(ctx);
    }

    @action({
        name: 'verifyRequest',
        params: {
            req: 'object',
        },
        tracing: {
            tags: {
                params: false,
            },
        },
        visibility: 'private',
    })
    protected async verifyRequest(
        ctx: Context<{ req: IncomingMessage & { originalUrl: string } }>,
    ) {
        const { req } = ctx.params;
        const { success, error, message } = parseReqSigV4(req);
        if (!success) {
            throw error;
        }

        return this.actions
            .getStoredSecretKey<Promise<string>>(
                {
                    accessKey: message.accessKey,
                },
                { parentCtx: ctx },
            )
            .then((secretKey) => {
                if (!secretKey) {
                    throw new Errors.MoleculerError('INVALID_ACCESS_KEY', 400);
                }
                const result = validateMessage(message, secretKey);
                if (!result.valid) {
                    throw new Errors.MoleculerError(result.error!, 400);
                }
                return true;
            });
    }

    @action({
        name: 'getStoredSecretKey',
        params: {
            accessKey: 'string',
        },
        cache: {
            keys: ['accessKey'],
            ttl: 3600,
        },
        visibility: 'private',
    })
    protected getStoredSecretKey(ctx: Context<{ accessKey: string }>) {
        const { accessKey } = ctx.params;
        const map = {
            uiyTaotpl7a2KhdNJ5cZnJ: 'yYRlci7NFkuh52sMuKFvds8QZCeRszrnk18cioRz0Xo',
        } as const;

        return (map as any)[accessKey];
    }

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
                const { req } = (ctx as Context<RestParams, RestMeta>).params;
                return `${req.method} ${req.url}`;
            },
        },
        timeout: 0,
    })
    public rest(ctx: Context<RestParams, RestMeta>) {
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
                await this.authorize.call(this, ctx, req);

                let packet: Packet;
                switch (typeis(req as any, ['json', 'multipart'])) {
                    case 'json': {
                        await new Promise((resolve) =>
                            this.jsonParser(req as any, res as any, resolve),
                        );
                        packet = req.body;
                        break;
                    }
                    case 'multipart': {
                        const busboy = new Busboy({
                            headers: {
                                'content-type': req.headers['content-type']!,
                            },
                        });
                        const bucket = new Bucket<any>();
                        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
                            bucket.push({ fieldname, file, filename, encoding, mimetype });
                        });
                        busboy.on('finish', () => {
                            console.log('Done parsing form!');
                        });
                        req.pipe(busboy);

                        for await (const { fieldname, file } of bucket) {
                            if (fieldname === 'packet') {
                                const buffer = Buffer.concat(await Array.fromAsync(file));
                                packet = JSON.parse(buffer.toString('utf8'));
                            } else if (fieldname === 'stream') {
                                packet!.stream = new PassThrough();
                                file.pipe(packet!.stream);
                                break;
                            }
                        }
                        if (!packet!) {
                            throw 'malformed response';
                        }
                        break;
                    }
                    default: {
                        throw new UnsupportedMediaType();
                    }
                }

                const context = this.payloadToContext(packet.data);
                if (packet.stream !== false) {
                    context.stream = packet.stream as Stream;
                }

                req.$params = context.params as Record<string, unknown>;

                context.broker = ctx.broker;

                if (context.action) {
                    const endpoint = this.broker.findNextActionEndpoint(
                        context.action as string,
                        context.options,
                        ctx,
                    );
                    if (endpoint instanceof Error) {
                        if (endpoint instanceof Errors.ServiceNotFoundError) {
                            throw new ServiceUnavailableError();
                        }
                        throw endpoint;
                    }
                    req.$endpoint = endpoint;
                    req.$action = endpoint.action;
                    context.endpoint = endpoint;
                    context.action = endpoint;

                    // Call the action
                    const data = await ctx.call(req.$endpoint as unknown as string, req.$params!, {
                        ...context.options,
                        stream: context.stream as any,
                        ctx: context,
                    });

                    // Send back the response
                    this.sendResponse(req, res, data);
                } else if (context.eventType) {
                    if (context.eventType === 'emit') {
                        await ctx.emit(context.eventName!, req.$params, {
                            groups: context.eventGroups,
                        });
                    } else if (context.eventType === 'broadcast') {
                        await ctx.broadcast(context.eventName!, req.$params, {
                            groups: context.eventGroups,
                        });
                    }
                }
                return resolve(true);
            } catch (err) {
                return reject(err);
            }
        });
    }

    @method
    private payloadToContext(payload: any) {
        const ctx = new this.broker.ContextFactory(this.broker);
        if ('action' in payload) {
            ctx.id = payload.id;
            ctx.action = payload.action;
            ctx.setParams(payload.params);
            ctx.parentID = payload.parentID;
            ctx.requestID = payload.requestID;
            ctx.caller = payload.caller;
            ctx.meta = payload.meta || {};
            ctx.locals = payload.locals || {};
            ctx.level = payload.level;
            ctx.tracing = payload.tracing;
            ctx.nodeID = payload.sender;

            if (payload.timeout != null) {
                ctx.options.timeout = payload.timeout;
            }
        } else if ('event' in payload) {
            ctx.id = payload.id;
            ctx.eventName = payload.event;
            ctx.setParams(payload.params);
            ctx.eventGroups = payload.groups;
            ctx.eventType = payload.broadcast ? 'broadcast' : 'emit';
            ctx.meta = payload.meta || {};
            ctx.locals = payload.locals || {};
            ctx.level = payload.level;
            ctx.tracing = !!payload.tracing;
            ctx.parentID = payload.parentID;
            ctx.requestID = payload.requestID;
            ctx.caller = payload.caller;
            ctx.nodeID = payload.sender;
        }
        return ctx;
    }

    @method
    private contextToPayload(ctx: Context) {
        if (ctx.action) {
            return {
                id: ctx.id,
                action: ctx.action?.name,
                params: ctx.params,
                meta: ctx.meta,
                timeout: ctx.options.timeout,
                locals: ctx.locals,
                level: ctx.level,
                tracing: ctx.tracing,
                parentID: ctx.parentID,
                requestID: ctx.requestID,
                caller: ctx.caller,
                handler: ctx.locals.handler,
            };
        } else if (ctx.event) {
            return {
                id: ctx.id,
                event: ctx.eventName,
                data: ctx.params,
                groups: ctx.eventGroups,
                broadcast: ctx.eventType == 'broadcast',
                meta: ctx.meta,
                locals: ctx.locals,
                level: ctx.level,
                tracing: ctx.tracing,
                parentID: ctx.parentID,
                requestID: ctx.requestID,
                caller: ctx.caller,
                needAck: ctx.needAck,
                handler: ctx.locals.handler,
            };
        } else {
            throw new Error();
        }
    }

    @method
    private async sendRequest(ctx: Context) {
        // headers.set(
        //     'Authorization',
        //     'Bearer ew0KImFsZyI6ICJIUzI1NiIsDQoidHlwIjogIkpXVCINCn0.ew0KImV4cCI6IDIwNTgxMTk4OTgsDQoiYXVkIjogIk1vbGVjdWxlclNpZGVjYXJDb25uZWN0b3IiLA0KInN1YiI6ICLQkNC00LzQuNC90LjRgdGC0YDQsNGC0L7RgCIsDQoibmJmIjogMTc0MjU1MDM3OCwNCiJpYXQiOiAxNzQyNTUwMzc4LA0KImlzcyI6ICJzc2wiDQp9.ZLd6mtkNxAZmSce85q3VLD3TBcMb08-UwxBpFAIStz8',
        // );

        // const url = 'https://mikhailtreg3adb.tail11e41.ts.net/wms/hs/moleculer/sidecar';
        // const handler = 'mol_InternalService.ListAction1';

        // Create an AbortController to handle timeout.
        const controller = new AbortController();
        const { signal } = controller;
        const timer =
            ctx.options.timeout &&
            setTimeout(() => {
                controller.abort();
            }, ctx.options.timeout);

        let response;
        try {
            const connection = ctx.locals.connection;
            delete ctx.locals.connection;

            // Validate the URL to catch invalid URL errors early
            const url = buildUrl(connection);

            const headers = new Headers();
            if (connection.auth) {
                if ('token' in connection.auth) {
                    headers.set('Authorization', `Bearer ${connection.auth.token}`);
                }
            }

            const payload = this.contextToPayload(ctx);
            const packet = {
                data: payload,
                sender: ctx.broker.nodeID,
                stream: ctx.stream ?? (false as const),
                meta: ctx.meta,
            };
            let body;
            if (packet.stream) {
                const formData = await packetToFormData(packet);
                headers.set('content-type', formData.getHeaders(headers)['content-type']);
                body = new PassThrough();
                formData.pipe(body);
            } else {
                headers.set('content-type', 'application/json');
                body = JSON.stringify(packet);
            }

            // Start the fetch request with the abort signal.
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
            if (error instanceof Error) {
                // Handle a request abort (timeout)
                if (error.name === 'AbortError') {
                    throw new RequestTimeoutError(url, error);
                }
            } else if (error instanceof TypeError) {
                // Handle invalid URL or incorrect fetch usage
                throw new RequestRejectedError(url, error);
            }
            convertToMoleculerError(error);
            throw error;
        }

        if (!response.ok) {
            return await handleErrorResponse(response);
        }
        const packet = await handleResponse(response, ctx);
        ctx.nodeID = packet.sender;
        Object.assign(ctx.meta || {}, packet!.meta || {});
        if (packet.stream) {
            return packet.stream;
        }
        return packet.data;
    }

    /**
     * HTTP request handler. It is called from native NodeJS HTTP server.
     */
    @method
    private async httpHandler(req: IncomingMessage, res: ServerResponse) {
        // Set pointers to service
        req.$startTime = process.hrtime();
        req.$service = this;

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
        const packet: Packet = {
            sender: ctx.nodeID!,
            data: _isStream ? null : data,
            meta: ctx.meta,
            stream: _isStream ? data : (false as any),
        };

        if (packet.stream === false) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            const responseData = this.encodeResponse(req, res, packet);
            return res.end(responseData);
        }

        const responseData = await packetToFormData(packet);
        res.writeHead(200, responseData.getHeaders());
        // return res.end(responseData.getBuffer());
        return responseData.pipe(res);
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

    @method
    private reformatError(error: Errors.MoleculerError, req: IncomingMessage, res: ServerResponse) {
        return _.pick(error, ['name', 'message', 'code', 'type', 'data', 'stack']);
    }

    /**
     * Log the request
     */
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
    @method
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
        if (!convertToMoleculerError(error)) {
            return undefined;
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
    protected async authorize(ctx: Context, req: IncomingMessage): Promise<Context> {
        const auth = req.headers['authorization'];
        if (!auth) {
            // No token
            return Promise.reject(new UnAuthorizedError(ERR_NO_TOKEN, null));
        }

        return this.actions
            .verifyRequest({ req }, { parentCtx: ctx })
            .then((valid) => {
                if (!valid) {
                    return Promise.reject(new UnAuthorizedError(ERR_INVALID_TOKEN, undefined));
                }
                return Promise.resolve(ctx);
            })
            .catch((error) => {
                return Promise.reject(new UnAuthorizedError(ERR_INVALID_TOKEN, error));
            });
    }

    /**
     * Log the response
     *
     * @param {HttpIncomingMessage} req
     * @param {HttpResponse} res
     * @param {any} data
     */
    @method
    private logResponse(req: IncomingMessage, res: ServerResponse, data?: unknown) {
        let time = '';
        if (req.$startTime) {
            const diff = process.hrtime(req.$startTime);
            const duration = (diff[0] + diff[1] / 1e9) * 1000;
            if (duration > 1000) time = kleur.red(`[+${Number(duration / 1000).toFixed(3)} s]`);
            else time = kleur.grey(`[+${Number(duration).toFixed(3)} ms]`);
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

    /**
     * Return with colored status code
     *
     */
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
