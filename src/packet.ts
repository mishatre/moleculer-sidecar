import type { IncomingHttpHeaders } from 'node:http';
import type Stream from 'node:stream';
import { PassThrough, Readable, type Transform } from 'node:stream';
import busboy from '@fastify/busboy';
import FormData from 'form-data';
import type { CallingOptions, Context, Endpoint, ServiceBroker } from 'moleculer';

// @fastify/busboy is CommonJS; see src/runtime/cjs-interop.ts.
const { Busboy } = busboy;

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
    [Symbol.asyncDispose]() {
        return Promise.resolve();
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

interface BusboyBucket {
    fieldname: string;
    file: Readable;
    filename: string;
    encoding: string;
    mimetype: string;
}

type Payload = {
    id: string;
    params: unknown;
    meta: Record<string, any>;
    locals: Record<string, any>;
    parentID: string | null;
    requestID: string | null;
    caller: string | null;
    level: number;
    tracing: boolean | null;
    sender: string | null;
    targetNodeID?: string;
    handler?: string;
} & (
    | {
          action: string;
          timeout: number | null;
      }
    | {
          event: string;
          groups: string[];
          broadcast: boolean;
      }
);

export default class Packet {
    constructor(
        public data: unknown,
        public sender: string | null,
        public stream: Stream | ReadableStream | WritableStream | Transform | boolean,
        public meta: Record<any, any>,
    ) {}

    public static fromJSON(string: string) {
        const init = JSON.parse(string);
        return new Packet(init.data, init.sender, init.stream || false, init.meta || {});
    }

    public static async fromMultipart(
        headers: IncomingHttpHeaders | Headers,
        readStream: Readable | ReadableStream,
    ) {
        const busboy = new Busboy({
            headers: {
                'content-type':
                    (headers instanceof Headers
                        ? headers.get('content-type')
                        : headers['content-type']) ?? '',
            },
        });
        const bucket = new Bucket<BusboyBucket>();
        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
            bucket.push({ fieldname, file, filename, encoding, mimetype });
        });
        busboy.on('finish', () => {
            console.log('Done parsing form!');
        });

        if (readStream instanceof ReadableStream) {
            Readable.fromWeb(readStream).pipe(busboy);
        } else {
            readStream.pipe(busboy);
        }

        let packet: Packet | undefined;
        for await (const { fieldname, file } of bucket) {
            if (fieldname === 'packet') {
                const buffer = Buffer.concat(await Array.fromAsync(file));
                packet = Packet.fromJSON(buffer.toString('utf8'));
            } else if (fieldname === 'stream') {
                if (packet === undefined) {
                    throw `multipart part with packet payload incorrect or doesn't exist or ordered incorrectly`;
                }
                packet.stream = new PassThrough();
                file.pipe(packet.stream as any);
                break;
            }
        }
        if (!packet!) {
            throw 'packet payload not found or malformed';
        }
        return packet;
    }

    public static fromContext(ctx: Context) {
        let data: Payload;
        if (ctx.action) {
            data = {
                id: ctx.id,
                action: ctx.action?.name!,
                params: ctx.params,
                meta: ctx.meta,
                timeout: ctx.options.timeout ?? null,
                locals: ctx.locals,
                level: ctx.level,
                tracing: ctx.tracing,
                parentID: ctx.parentID,
                requestID: ctx.requestID,
                caller: ctx.caller,
                sender: ctx.nodeID,
                handler: ctx.locals.handler,
            };
        } else if (ctx.event) {
            data = {
                id: ctx.id,
                event: ctx.eventName!,
                params: ctx.params,
                groups: ctx.eventGroups ?? [],
                broadcast: ctx.eventType == 'broadcast',
                meta: ctx.meta,
                locals: ctx.locals,
                level: ctx.level,
                tracing: ctx.tracing,
                parentID: ctx.parentID,
                requestID: ctx.requestID,
                caller: ctx.caller,
                sender: ctx.nodeID,
                // needAck: ctx.needAck,
                handler: ctx.locals.handler,
            };
        } else {
            throw new Error('Unsupported moleculer context state');
        }
        return new Packet(
            data,
            ctx.broker.nodeID,
            (ctx as Context & { stream?: Stream | boolean }).stream ?? (false as const),
            ctx.meta,
        );
    }

    public toContext(broker: ServiceBroker, parentCtx: Context) {
        const payload = this.data as Payload;

        const ctx = broker.ContextFactory.create(
            broker,
            undefined as unknown as Endpoint,
            payload.params as Record<string, unknown>,
            {
                parentCtx,
            },
        );
        if ('action' in payload) {
            ctx.id = payload.id;
            ctx.action = payload.action as any;
            ctx.setParams(payload.params);
            ctx.parentID = payload.parentID;
            ctx.caller = payload.caller;
            ctx.meta = payload.meta || {};
            ctx.locals = payload.locals || {};
            ctx.level = payload.level;
            ctx.tracing = payload.tracing;
            ctx.nodeID = payload.sender;
            if (payload.timeout != null) {
                ctx.options.timeout = payload.timeout;
            }
            if (payload.targetNodeID != null) {
                ctx.options.nodeID = payload.targetNodeID;
            }
            if (this.stream !== false) {
                (ctx as Context & { stream?: Packet['stream'] }).stream = this.stream;
                (ctx.options as CallingOptions & { stream?: Packet['stream'] }).stream =
                    this.stream;
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

    public async toFormData() {
        const stream = this.stream;
        this.stream = true;

        const formData = new FormData();
        formData.append('packet', Buffer.from(this.toJSON()), {
            contentType: 'application/json',
            filename: 'packet',
        });

        formData.append('stream', Buffer.concat(await Array.fromAsync(stream as any)), {
            contentType: 'application/octet-stream',
            filename: 'stream',
        });

        return formData;
    }

    public toJSON() {
        const { data, sender, meta, stream } = this;
        return JSON.stringify({ data, sender, meta, stream });
    }
}
