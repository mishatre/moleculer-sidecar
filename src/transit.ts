import {
    Context,
    Endpoint,
    Errors,
    LoggerInstance,
    ServiceBroker,
    ServiceItem,
    ServiceSchema,
} from 'moleculer';
import { parseStringPromise } from 'xml2js';

import { Packet, PacketPayload, PacketType, RawPacket } from './packet';

async function convert1CErrorToMoleculerError(response: Response, errorText: string) {
    const xmlData = await parseStringPromise(errorText);
    const errorDescription = xmlData.exception.descr[0]._;
    const errorStack = xmlData.exception.creationStack[0]._;
    const error = new Errors.MoleculerError(errorDescription, response.status, response.statusText);
    error.stack = errorStack;

    return error;
}

export class SidecarTransit {
    private logger: LoggerInstance;
    private nodeID: string;
    private instanceID: string;
    private opts: {
        maxQueueSize: number;
    };

    private pendingRequests = new Map();

    constructor(
        private broker: ServiceBroker,
        private service: ServiceSchema,
    ) {
        this.logger = broker.getLogger('sidecar-transit');
        this.nodeID = broker.nodeID;
        this.instanceID = broker.instanceID;
        this.opts = {
            maxQueueSize: 100,
        };
    }

    public messageHandler(cmd: string, rawPacket: RawPacket, ctx: Context) {
        const packet = Packet.fromRaw(rawPacket);

        // Request
        if (packet.type === PacketType.PACKET_REQUEST) {
            return this.requestHandler(packet.payload, ctx);
        }
        // Response
        else if (packet.type === PacketType.PACKET_RESPONSE) {
            return this.responseHandler(packet.payload);
        }
        // Event
        else if (packet.type === PacketType.PACKET_EVENT) {
            return this.eventHandler(packet.payload);
        }
        // Discover
        else if (packet.type === PacketType.PACKET_DISCOVER) {
            const packet = new Packet(PacketType.PACKET_INFO, this.broker.nodeID, {
                name: this.service.schema.name,
                version: this.service.schema.version,
                fullName: this.service.fullName,
                metadata: this.service.schema.metadata,
                available: true,
            });
            packet.extend(this.broker.nodeID, '1');
            return packet;
        }
    }

    public eventHandler(payload: PacketPayload<PacketType.PACKET_EVENT>) {
        this.logger.debug(
            `Event '${payload.event}' received from '${payload.sender}' node` +
                (payload.groups ? ` in '${payload.groups.join(', ')}' group(s)` : '') +
                '.',
        );

        if (this.broker.stopping) {
            this.logger.warn(
                `Incoming '${payload.event}' event from '${payload.sender}' node is dropped, because broker is stopped.`,
            );
            // return false so the transporter knows this event wasn't handled.
            return Promise.resolve(false);
        }

        // Create caller context
        const ctx = new this.broker.ContextFactory(this.broker, undefined as unknown as Endpoint);
        ctx.id = payload.id;
        ctx.eventName = payload.event;
        ctx.setParams(payload.data, this.broker.options.contextParamsCloning);
        ctx.eventGroups = payload.groups;
        ctx.eventType = payload.broadcast ? 'broadcast' : 'emit';
        ctx.meta = payload.meta || {};
        ctx.level = payload.level;
        ctx.tracing = !!payload.tracing;
        ctx.parentID = payload.parentID;
        ctx.requestID = payload.requestID;
        ctx.caller = payload.caller;
        ctx.nodeID = payload.sender;

        // ensure the eventHandler resolves true when the event was handled successfully
        return this.broker.emitLocalServices(ctx).then(() => true);
    }

    public async requestHandler(
        payload: PacketPayload<PacketType.PACKET_REQUEST>,
        reqCtx: Context,
    ) {
        const requestID = payload.requestID ? "with requestID '" + payload.requestID + "' " : '';
        this.logger.debug(
            `<= Request '${payload.action}' ${requestID}received from '${payload.sender}' node.`,
        );

        let response, meta, error;

        try {
            if (this.broker.stopping) {
                this.logger.warn(
                    `Incoming '${payload.action}' ${requestID}request from '${payload.sender}' node is dropped because broker is stopped.`,
                );
                throw new Errors.ServiceNotAvailableError({
                    action: payload.action,
                    nodeID: this.nodeID,
                });
            }

            let endpoint;
            if (payload.action.startsWith('$sidecar')) {
                endpoint = this.broker._getLocalActionEndpoint(payload.action);
            } else {
                endpoint = this.broker.findNextActionEndpoint(payload.action);
            }
            if (endpoint instanceof Error) {
                throw new Errors.ServiceNotFoundError({
                    action: payload.action,
                    nodeID: this.nodeID,
                });
            }

            // Recreate caller context
            const ctx = this.broker.ContextFactory.create(
                this.broker,
                endpoint,
                {},
                { parentCtx: reqCtx },
            );
            ctx.setEndpoint(endpoint);
            ctx.id = payload.id;
            ctx.setParams(payload.params, this.broker.options.contextParamsCloning);
            // ctx.parentID = payload.parentID;
            // ctx.requestID = payload.requestID;
            ctx.caller = payload.caller;
            ctx.meta = payload.meta || {};
            ctx.level = payload.level;
            ctx.tracing = payload.tracing;
            ctx.nodeID = payload.sender;

            if (payload.timeout != null) ctx.options.timeout = payload.timeout;

            const p = endpoint.action?.handler?.(ctx) as Promise<any> & { ctx: Context };
            // Pointer to Context
            p.ctx = ctx;

            meta = ctx.meta;

            try {
                response = await p;
            } catch (err) {
                error = err;
            }
        } catch (err) {
            error = err;
        }

        // Return the response
        const packet = new Packet(PacketType.PACKET_RESPONSE, payload.sender, {
            id: payload.id,
            meta,
            success: error == null,
            error: error
                ? this.broker.errorRegenerator.extractPlainError(error, payload)
                : undefined,
            data: response,
        });
        packet.extend(this.nodeID, '1');

        return packet;
    }

    public responseHandler(payload: PacketPayload<PacketType.PACKET_RESPONSE>) {
        const id = payload.id;
        const req = this.pendingRequests.get(id);

        // If not exists (timed out), we skip response processing
        if (req == null) {
            this.logger.debug(
                'Orphan response is received. Maybe the request is timed out earlier. ID:',
                payload.id,
                ', Sender:',
                payload.sender,
            );
            // this.metrics.increment(METRIC.MOLECULER_TRANSIT_ORPHAN_RESPONSE_TOTAL);
            return;
        }

        this.logger.debug(`<= Response '${req.action.name}' is received from '${payload.sender}'.`);

        // Update nodeID in context (if it uses external balancer)
        req.ctx.nodeID = payload.sender;

        // Merge response meta with original meta
        Object.assign(req.ctx.meta || {}, payload.meta || {});

        // Handle stream response
        // if (packet.stream != null) {
        // 	if (this._handleIncomingResponseStream(packet, req)) return;
        // }

        // Remove pending request
        this.pendingRequests.delete(id);

        if (!payload.success) {
            return req.reject(payload.error); //this._createErrFromPayload(packet.error, packet);
        }
        return req.resolve(payload.data);
    }

    public request(ctx: Context) {
        const actionName = ctx.action?.name;

        if (this.opts.maxQueueSize && this.pendingRequests.size >= this.opts.maxQueueSize) {
            return Promise.reject(
                new Errors.QueueIsFullError({
                    action: actionName,
                    nodeID: this.nodeID,
                    size: this.pendingRequests.size,
                    limit: this.opts.maxQueueSize,
                }),
            );
        }

        return new Promise((resolve, reject) => {
            const request = {
                action: ctx.action,
                nodeID: ctx.nodeID,
                ctx,
                resolve,
                reject,
            };

            const payload = {
                id: ctx.id,
                action: actionName,
                params: ctx.params,
                meta: ctx.meta,
                timeout: ctx.options.timeout,
                level: ctx.level,
                tracing: ctx.tracing,
                parentID: ctx.parentID,
                requestID: ctx.requestID,
                caller: ctx.caller,
            };

            const packet = new Packet(PacketType.PACKET_REQUEST, ctx.nodeID, payload);

            const nodeName = ctx.nodeID ? `'${ctx.nodeID}'` : 'someone';
            const requestID = ctx.requestID ? `with requestID '${ctx.requestID}'` : '';
            this.logger.debug(`=> Send '${actionName}' request ${requestID}to ${nodeName} node.`);

            const publishCatch = (err: unknown) => {
                this.logger.error(
                    `Unable to send '${actionName}' request ${requestID}to ${nodeName} node.`,
                    err,
                );

                this.broker.broadcastLocal('$transit.error', {
                    error: err,
                    module: 'transit',
                    type: 'FAILED_SEND_REQUEST_PACKET',
                });
            };

            // Add to pendings
            this.pendingRequests.set(ctx.id, request);

            // Publish request
            return this.send(packet, ctx.endpoint?.node.gateway).catch((error: unknown) => {
                publishCatch(error);
                reject(error);
            });
        });
    }

    public sendEvent(ctx: Context) {
        const groups = ctx.eventGroups;
        const requestID = ctx.requestID ? "with requestID '" + ctx.requestID + "' " : '';
        if (ctx.endpoint)
            this.logger.debug(
                `=> Send '${ctx.eventName}' event ${requestID}to '${ctx.nodeID}' node` +
                    (groups ? ` in '${groups.join(', ')}' group(s)` : '') +
                    '.',
            );
        else
            this.logger.debug(
                `=> Send '${ctx.eventName}' event ${requestID}to '${groups.join(', ')}' group(s).`,
            );

        const packet = new Packet(PacketType.PACKET_EVENT, ctx.endpoint ? ctx.nodeID : null, {
            id: ctx.id,
            event: ctx.eventName,
            data: ctx.params,
            groups,
            broadcast: ctx.eventType == 'broadcast',
            meta: ctx.meta,
            level: ctx.level,
            tracing: ctx.tracing,
            parentID: ctx.parentID,
            requestID: ctx.requestID,
            caller: ctx.caller,
            needAck: ctx.needAck,
        });

        return this.send(packet, ctx.endpoint?.node.gateway).catch(
            /* istanbul ignore next */ (err) => {
                this.logger.error(
                    `Unable to send '${ctx.eventName}' event ${requestID}to groups.`,
                    err,
                );

                this.broker.broadcastLocal('$transit.error', {
                    error: err,
                    module: 'transit',
                    type: 'FAILED_SEND_EVENT_PACKET',
                });
            },
        );
    }

    public discoverNode() {}

    public sendNodeInfo() {}

    public sendPing(payload) {}

    public sendPoing(payload) {}

    public sendHeartbeat() {}

    private send(packet, gateway) {
        packet.extend(this.nodeID, '1');

        const headers = new Headers();
        headers.set('content-type', 'application/json');
        headers.set('accept', 'application/json');

        for (const [key, value] of gateway.authHeaders()) {
            headers.set(key, value);
        }

        return fetch(gateway.url(), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                cmd: packet.type,
                packet,
            }),
        })
            .then(async (response) => {
                if (!response.ok) {
                    throw new Errors.ServiceNotAvailableError({
                        statusText: response.statusText,
                        status: response.status,
                    });
                }

                const contentType = response.headers.get('content-type');
                if (!contentType) {
                    throw new Errors.RequestRejectedError({
                        reason: 'Missing content-type',
                    });
                }

                if (contentType.startsWith('application/xml')) {
                    // Handle 1C error
                    const xmlText = await response.text();
                    const error = await convert1CErrorToMoleculerError(response, xmlText);
                    throw error;
                }

                if (!contentType.startsWith('application/json')) {
                    const responseText = await response.text();
                    throw new Errors.InvalidPacketDataError({
                        responseText,
                        status: response.status,
                        statusText: response.statusText,
                    });
                }

                return response.json() as Promise<{ cmd: string; packet: RawPacket }>;
            })
            .then((response) => {
                if (!response) {
                    return true;
                }
                try {
                    const { cmd, packet } = response;
                    return this.messageHandler(cmd, packet);
                } catch (err) {
                    this.logger.warn('Invalid incoming packet. Type:', response.cmd, err);
                    this.logger.debug('Content:', JSON.stringify(response.packet));
                    throw err;
                }
            });
    }
}
