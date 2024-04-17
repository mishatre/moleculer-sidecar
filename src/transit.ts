import { Context, Endpoint, Errors, LoggerInstance, ServiceBroker } from 'moleculer';
import { parseStringPromise } from 'xml2js';

import { Gateway, NodeGateway } from './gateway';
import { Packet, PacketType, PayloadByPacketType } from './packet';
import SidecarService from './services/sidecar.service';

async function convert1CErrorToMoleculerError(response: Response, errorText: string) {
    const xmlData = await parseStringPromise(errorText);
    const errorDescription = xmlData.exception.descr[0]._;
    const errorStack = xmlData.exception.creationStack[0]._;
    const error = new Errors.MoleculerError(errorDescription, response.status, response.statusText);
    error.stack = errorStack;

    return error;
}

function isRequestPacket(cmd: PacketType): cmd is PacketType.PACKET_REQUEST {
    return cmd === PacketType.PACKET_REQUEST;
}

export class SidecarTransit {
    private nodeID: string;
    public instanceID: string;
    private opts: {
        maxQueueSize: number;
    };

    private broker: ServiceBroker;
    private logger: LoggerInstance;

    private pendingRequests = new Map();

    constructor(private sidecar: SidecarService) {
        this.nodeID = sidecar.broker.nodeID;
        this.instanceID = sidecar.broker.instanceID;
        this.opts = {
            maxQueueSize: 100,
        };

        this.logger = sidecar.broker.getLogger('sidecar-transit');
        this.broker = sidecar.broker;
    }

    public incomingMessage(message: string, ctx: Context, resolve: Function, reject: Function) {
        try {
            const packet = Packet.deserialize(message);
            ctx.locals = {
                resolve,
                reject,
            };
            return this.messageHandler(packet.type, packet, ctx);
        } catch (error) {
            // return error packet
            reject(error);
        }
    }

    private messageHandler(cmd: PacketType, packet: Packet<typeof cmd>, ctx?: Context) {
        try {
            const payload = packet.payload;

            if (isRequestPacket(cmd)) {
                return this.requestHandler(payload, ctx!);
            } else if (cmd === PacketType.PACKET_RESPONSE) {
                return this.responseHandler(payload);
            } else if (cmd === PacketType.PACKET_EVENT) {
                return this.eventHandler(payload);
            } else if (cmd === PacketType.PACKET_CHANNEL_EVENT_REQUEST) {
                return this.channelEventHandler(payload, ctx!);
            } else if (cmd === PacketType.PACKET_DISCOVER) {
                return this.sendNodeInfo(payload, ctx!);
            } else if (cmd === PacketType.PACKET_INFO) {
                this.sidecar.registry.processNodeInfo(payload);
            } else if (cmd === PacketType.PACKET_SERVICES_INFO) {
                return payload.services;
            } else if (cmd === PacketType.PACKET_DISCONNECT) {
                this.sidecar.registry.nodes.disconnected(payload.sender, false);
            } else if (cmd === PacketType.PACKET_HEARTBEAT) {
                this.sidecar.registry.heartbeatReceived(payload.sender, payload);
            } else if (cmd === PacketType.PACKET_PING) {
                // return this.sendPong(payload, ctx);
            } else if (cmd === PacketType.PACKET_PONG) {
                // return this.processPong(payload, ctx);
            }
            if (ctx) {
                return ctx.locals.resolve(true);
            }
            return true;
        } catch (error) {
            this.logger.error(error);
        }
        if (ctx) {
            return ctx.locals.resolve(false);
        }
        return false;
    }

    private async requestHandler(
        payload: PayloadByPacketType[PacketType.PACKET_REQUEST],
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
            ctx.nodeID = endpoint.id;

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
                ? this.broker.errorRegenerator?.extractPlainError(error, payload)
                : undefined,
            data: response,
        });
        packet.extend(this.nodeID, '1');

        if (reqCtx.locals.resolve) {
            return reqCtx.locals.resolve(packet);
        }
    }

    private responseHandler(payload: PayloadByPacketType[PacketType.PACKET_RESPONSE]) {
        const id = payload.id;
        const req = this.pendingRequests.get(id);

        if (!req) {
            this.logger.debug(`<= Custom response is received from '${payload.sender}'.`);
            if (!payload.success) {
                throw payload.error; //this._createErrFromPayload(packet.error, packet);
            }
            return payload.data;
        }

        if (req) {
            this.logger.debug(
                `<= Response '${req.action.name}' is received from '${payload.sender}'.`,
            );
        }

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

    private eventHandler(payload: PayloadByPacketType[PacketType.PACKET_EVENT]) {
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
        ctx.eventType = payload.eventType;
        ctx.meta = payload.meta || {};
        ctx.level = payload.level;
        ctx.tracing = !!payload.tracing;
        ctx.parentID = payload.parentID;
        ctx.requestID = payload.requestID;
        ctx.caller = payload.caller;
        ctx.nodeID = payload.sender;

        if (ctx.eventType === 'emit') {
            return this.broker.emit(ctx.eventName, ctx.params, {
                parentCtx: ctx,
            });
        } else if (ctx.eventType === 'broadcast') {
            return this.broker.broadcast(ctx.eventName, ctx.params, {
                parentCtx: ctx,
            });
        } else if (ctx.eventType === 'broadcastLocal') {
            return this.broker.broadcastLocal(ctx.eventName, ctx.params, {
                parentCtx: ctx,
            });
        } else {
            console.log('unknown eventType', ctx.eventType);
            return undefined;
        }
    }

    public channelEventHandler(
        payload: PayloadByPacketType[PacketType.PACKET_CHANNEL_EVENT_REQUEST],
        ctx: Context,
    ) {
        return this.broker
            .sendToChannel(payload.channelName, payload.data, payload.opts)
            .then(ctx.locals.resolve)
            .catch(ctx.locals.reject);
    }

    public request(ctx: Context) {
        const actionName = ctx.action?.name;

        return new Promise((resolve, reject) => {
            const request = {
                action: ctx.action,
                nodeID: ctx.nodeID,
                ctx,
                resolve,
                reject,
            };

            const packet = new Packet(PacketType.PACKET_REQUEST, ctx.nodeID, {
                id: ctx.id,
                action: actionName!,
                params: ctx.params,
                meta: ctx.meta,
                timeout: ctx.options.timeout!,
                level: ctx.level,
                tracing: ctx.tracing!,
                parentID: ctx.parentID!,
                requestID: ctx.requestID!,
                caller: ctx.caller!,

                handler: ctx.action!.handler as unknown as string,
            });

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

    public sendEvent(handler: string, ctx: Context) {
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
                `=> Send '${ctx.eventName}' event ${requestID}to '${groups!.join(', ')}' group(s).`,
            );

        const packet = new Packet(PacketType.PACKET_EVENT, ctx.endpoint ? ctx.nodeID : null, {
            id: ctx.id,
            event: ctx.eventName!,
            data: ctx.params,
            groups: groups!,
            eventType: ctx.eventType!,
            meta: ctx.meta,
            level: ctx.level,
            tracing: ctx.tracing!,
            parentID: ctx.parentID!,
            requestID: ctx.requestID!,
            caller: ctx.caller!,
            needAck: ctx.needAck!,

            handler,
        });

        return this.send(packet, ctx.endpoint!.node.gateway).catch((err) => {
            this.logger.error(
                `Unable to send '${ctx.eventName}' event ${requestID}to groups.`,
                err,
            );

            this.broker.broadcastLocal('$sidecar-transit.error', {
                error: err,
                module: 'transit',
                type: 'FAILED_SEND_EVENT_PACKET',
            });
        });
    }

    public sendChannelEvent(handler: string, ctx: Context, raw: any) {
        const requestID = ctx.requestID ? "with requestID '" + ctx.requestID + "' " : '';
        if (ctx.endpoint) {
            this.logger.debug(`=> Send channel event ${requestID}to '${ctx.nodeID}' node.`);
        }

        const packet = new Packet(
            PacketType.PACKET_CHANNEL_EVENT,
            ctx.endpoint ? ctx.nodeID : null,
            {
                id: ctx.id,
                data: ctx.params,
                meta: ctx.meta,
                tracing: ctx.tracing,
                requestID: ctx.requestID,
                raw: {
                    info: raw.info,
                    redelivered: raw.redelivered,
                    reply: raw.reply,
                    seq: raw.seq,
                    sid: raw.sid,
                    subject: raw.subject,
                },

                handler,
            },
        );

        return this.send(packet, ctx.endpoint?.node.gateway).catch(
            /* istanbul ignore next */ (err) => {
                this.logger.error(
                    `Unable to send channel event ${requestID} to '${ctx.nodeID}' node.`,
                    err,
                );

                this.broker.broadcastLocal('$sidecar-transit.error', {
                    error: err,
                    module: 'transit',
                    type: 'FAILED_SEND_EVENT_PACKET',
                });
            },
        );
    }

    public sendNodeInfo(nodeID: string, ctx: Context) {
        try {
            const info = this.broker.getLocalNodeInfo();
            const packet = new Packet(PacketType.PACKET_INFO, nodeID, {
                services: info.services,
                ipList: info.ipList,
                hostname: info.hostname,
                client: info.client,
                config: info.config,
                instanceID: this.broker.instanceID,
                metadata: info.metadata,
                seq: info.seq,
                sidecarNodes: this.sidecar.registry.getNodeList(),
            });
            packet.extend(this.nodeID, '1');

            ctx.locals.resolve(packet);
        } catch (error) {
            this.logger.error(`Unable to send INFO packet to '${nodeID}' node.`, error);

            this.broker.broadcastLocal('$transit.error', {
                error,
                module: 'transit',
                type: 'FAILED_SEND_INFO_PACKET',
            });
        }
    }

    public requestHeartbeat(nodeID: string, gateway: NodeGateway) {
        this.logger.debug(`=> Send heartbeat request to ${nodeID} node.`);
        const packet = new Packet(PacketType.PACKET_REQUEST_HEARTBEAT, nodeID, {});
        return this.send(packet, new Gateway(gateway));
    }

    public discoverNode(nodeID: string, gateway: NodeGateway) {
        const packet = new Packet(PacketType.PACKET_DISCOVER, nodeID, {});
        return this.send(packet, new Gateway(gateway));
    }

    public discoverNodeServices(nodeID: string, gateway: NodeGateway) {
        const packet = new Packet(PacketType.PACKET_DISCOVER_SERVICES, nodeID, {});
        return this.send(packet, new Gateway(gateway));
    }

    private send(packet: Packet<any>, gateway: Gateway) {
        packet.extend(this.nodeID, '1');

        const headers = new Headers();
        headers.set('content-type', 'application/json');
        headers.set('accept', 'application/json');

        for (const [key, value] of gateway.authHeaders()) {
            headers.set(key, value);
        }

        this.logger.warn(packet);

        return fetch(gateway.url(), {
            method: 'POST',
            headers,
            body: packet.serialize(),
        })
            .then(async (response) => {
                if (!response.ok) {
                    throw new Errors.ServiceNotAvailableError({
                        statusText: response.statusText,
                        status: response.status,
                        text: await response.text(),
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

                return response.text() as Promise<string>;
            })
            .then((message) => {
                if (!message) {
                    return true;
                }
                try {
                    const packet = Packet.deserialize(message);
                    return this.messageHandler(packet.type, packet);
                } catch (err) {
                    this.logger.warn('Invalid incoming packet.', err);
                    this.logger.debug('Content:', message);
                    throw err;
                }
            });
    }
}
