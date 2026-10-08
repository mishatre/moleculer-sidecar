import { PassThrough } from 'node:stream';
import bodyParser, { type BodyParser } from 'body-parser';
import { isStream } from 'is-stream';
import _ from 'lodash';
import { action, created, defineSettings, method, service, started, stopped } from 'moldecor';
import type { CallingOptions, Context } from 'moleculer';
import {
    convert1CErrorToMoleculerError,
    convertToMoleculerError,
    MethodNotAllowed,
    RequestRejectedError,
    RequestTimeoutError,
    UnsupportedMediaType,
} from '../errors.js';
import Packet from '../packet.js';
import { Errors, is, Service as MoleculerService } from '../runtime/cjs-interop.js';
import {
    HttpServer,
    type ServerRequest,
    type ServerSettings,
    serverSettings,
    setServer,
} from '../server.js';
import type { AuthInfo, ConnectionInfo, IncomingMessage, ServerResponse } from '../types.js';
import { buildUrl } from '../utils/utils.js';

interface Settings extends ServerSettings {
    //
    path: string;
}

interface RestParams {
    req: IncomingMessage;
    res: ServerResponse;
}

const GATEWAY_PATH = '/sidecar';

const settings = defineSettings<Partial<Settings>>({
    ...serverSettings,

    // Sidecar path
    path: GATEWAY_PATH,
});

@service({
    name: 'api-gateway',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    settings,
})
export default class ApiGateway extends MoleculerService<typeof settings> {
    private server!: HttpServer;

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
            spanName: (ctx: Context) => {
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
     * Request handler mounted at the gateway path.
     */
    @method
    private async handleRequest({ req, res }: ServerRequest) {
        // Prevent connection to any other endpoints
        if (req.method !== 'POST') {
            return this.server.sendError(req, res, new MethodNotAllowed());
        }

        const options: CallingOptions = {};
        try {
            await this.actions.rest({ req, res }, options);
        } catch (error: unknown) {
            this.server.errorHandler(req, res, error);
        }
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

    @created
    public created() {
        this.server = new HttpServer(this.settings, this.logger, 'Sidecar gateway');
        this.server.mount(
            this.settings.path ?? GATEWAY_PATH,
            (request) => this.handleRequest(request),
            'exact',
        );
        // Paths outside the gateway mount keep the pre-refactor precedence.
        this.server.setFallback(({ req, res }) =>
            req.method === 'POST'
                ? this.server.send404(req, res)
                : this.server.sendError(req, res, new MethodNotAllowed()),
        );
        setServer(this.server);

        this.jsonParser = bodyParser.json();

        this.logger.info('Sidecar gateway server created.');
    }

    @started
    public async started() {
        await this.server.listen();
    }

    @stopped
    public stopped() {
        return this.server.close();
    }
}
