import {
    CallingOptions,
    Context,
    Endpoint,
    Errors,
    LoggerInstance,
    ServiceBroker,
} from 'moleculer';
import { parseStringPromise } from 'xml2js';

import { Gateway } from './gateway.js';
import SidecarService from './index.service.js';
import { PacketFactory } from './packet-factory.js';
import { Packet, PacketType, PayloadByPacketType } from './packet.js';

async function convert1CErrorToMoleculerError(response: Response, errorText: string) {
    const xmlData = await parseStringPromise(errorText);
    const errorDescription = xmlData.exception.descr[0]._;
    const errorStack = xmlData.exception.creationStack[0]._;
    const error = new Errors.MoleculerError(errorDescription, response.status, response.statusText);
    error.stack = errorStack;

    return error;
}

export class SidecarTransit {
    public packetFactory: PacketFactory;

    private nodeID: string;
    public instanceID: string;

    private broker: ServiceBroker;
    private logger: LoggerInstance;

    private pendingRequests = new Map();

    constructor(private sidecar: SidecarService) {
        this.nodeID = sidecar.broker.nodeID;
        this.instanceID = sidecar.broker.instanceID;

        this.logger = sidecar.broker.getLogger('sidecar-transit');
        this.broker = sidecar.broker;

        this.packetFactory = new PacketFactory(this.broker, '1');
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

    private messageHandler(cmd: PacketType, packet: Packet<any>, ctx?: Context) {
        try {
            if (packet.type === PacketType.PACKET_REQUEST) {
                return this.requestHandler(packet, ctx!);
            } else if (packet.type === PacketType.PACKET_RESPONSE) {
                return this.responseHandler(packet);
            } else if (packet.type === PacketType.PACKET_EVENT) {
                return this.eventHandler(packet, ctx!);
            } else if (packet.type === PacketType.PACKET_CHANNEL_EVENT_REQUEST) {
                return this.channelEventHandler(packet, ctx!);
            } else if (packet.type === PacketType.PACKET_DISCOVER) {
                return this.sendNodeInfo(packet.sender, ctx!);
            } else if (packet.type === PacketType.PACKET_INFO) {
                this.sidecar.registry.processNodeInfo(packet.sender, packet.payload);
            } else if (packet.type === PacketType.PACKET_SERVICES_INFO) {
                return packet.payload.services;
            } else if (packet.type === PacketType.PACKET_DISCONNECT) {
                this.sidecar.registry.nodes.disconnected(packet.sender, false);
            } else if (packet.type === PacketType.PACKET_HEARTBEAT) {
                this.sidecar.registry.heartbeatReceived(packet.sender, packet.payload);
            } else if (packet.type === PacketType.PACKET_PING) {
                // return this.sendPong(payload, ctx);
            } else if (packet.type === PacketType.PACKET_PONG) {
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

    private async requestHandler(packet: Packet<PacketType.PACKET_REQUEST>, reqCtx: Context) {
        const { payload, sender } = packet;
        const requestID = payload.requestID ? "with requestID '" + payload.requestID + "' " : '';
        this.logger.debug(
            `<= Request '${payload.action}' ${requestID}received from '${sender}' node.`,
        );

        let data, meta, error;

        try {
            if (this.broker.stopping) {
                this.logger.warn(
                    `Incoming '${payload.action}' ${requestID}request from '${sender}' node is dropped because broker is stopped.`,
                );
                throw new Errors.ServiceNotAvailableError({
                    action: payload.action,
                    nodeID: this.nodeID,
                });
            }

            // Recreate caller context
            const ctx = this.broker.ContextFactory.create(
                this.broker,
                undefined as unknown as Endpoint,
                {},
                { parentCtx: reqCtx },
            );
            ctx.id = payload.id;
            ctx.setParams(payload.params, this.broker.options.contextParamsCloning);
            // ctx.parentID = payload.parentID;
            // ctx.requestID = payload.requestID;
            ctx.caller = payload.caller;
            ctx.meta = payload.meta || {};
            ctx.level = payload.level;
            ctx.tracing = payload.tracing;

            if (payload.timeout != null) {
                ctx.options.timeout = payload.timeout;
            }

            try {
                data = await this.broker.call(payload.action, payload.params, {
                    ctx,
                } as unknown as CallingOptions);
            } catch (err) {
                error = err;
            }
        } catch (err) {
            error = err;
        }

        // Return the response
        const responsePacket = this.packetFactory.response(sender, payload.id, error, data, meta);

        if (reqCtx.locals.resolve) {
            return reqCtx.locals.resolve(responsePacket);
        }
        return responsePacket;
    }

    private responseHandler(packet: Packet<PacketType.PACKET_RESPONSE>) {
        const { payload, sender } = packet;
        const id = payload.id;
        const req = this.pendingRequests.get(id);

        if (!req) {
            this.logger.debug(`<= Custom response is received from '${sender}'.`);
            if (!payload.success) {
                throw payload.error;
            }
            return payload.data;
        }

        if (req) {
            this.logger.debug(`<= Response '${req.action.name}' is received from '${sender}'.`);
        }

        // Update nodeID in context (if it uses external balancer)
        req.ctx.nodeID = sender;

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

    private eventHandler(packet: Packet<PacketType.PACKET_EVENT>, reqCtx: Context) {
        const { payload, sender } = packet;
        this.logger.debug(
            `Event '${payload.event}' received from '${sender}' node` +
                (payload.groups ? ` in '${payload.groups.join(', ')}' group(s)` : '') +
                '.',
        );

        if (this.broker.stopping) {
            this.logger.warn(
                `Incoming '${payload.event}' event from '${sender}' node is dropped, because broker is stopped.`,
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
        ctx.nodeID = sender;

        try {
            let action = undefined;
            if (ctx.eventType === 'emit') {
                action = this.broker.emit;
            } else if (ctx.eventType === 'broadcast') {
                action = this.broker.broadcast;
            } else if (ctx.eventType === 'broadcastLocal') {
                action = this.broker.broadcastLocal;
            } else {
                console.log('unknown eventType', ctx.eventType);
                return undefined;
            }
            return action(ctx.eventName, ctx.params, {
                parentCtx: ctx,
                groups: ctx.eventGroups,
            });
        } finally {
            if (reqCtx.locals.resolve) {
                reqCtx.locals.resolve();
            }
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
        return new Promise((resolve, reject) => {
            const request = {
                action: ctx.action,
                nodeID: ctx.nodeID,
                ctx,
                resolve,
                reject,
            };

            const actionName = ctx.action?.name;

            const nodeName = ctx.nodeID ? `'${ctx.nodeID}'` : 'someone';
            const requestID = ctx.requestID ? `with requestID '${ctx.requestID}'` : '';
            this.logger.debug(`=> Send '${actionName}' request ${requestID}to ${nodeName} node.`);

            // Add to pendings
            this.pendingRequests.set(ctx.id, request);

            // Publish request
            return this.send(this.packetFactory.request(ctx), ctx.locals.gateway).catch(
                (error: unknown) => {
                    this.logger.error(
                        `Unable to send '${actionName}' request ${requestID}to ${nodeName} node.`,
                        error,
                    );

                    this.broker.broadcastLocal('$sidecar-transit.error', {
                        error,
                        module: 'transit',
                        type: 'FAILED_SEND_REQUEST_PACKET',
                    });

                    reject(error);
                },
            );
        });
    }

    public sendEvent(ctx: Context) {
        const groups = ctx.eventGroups;
        const requestID = ctx.requestID ? "with requestID '" + ctx.requestID + "' " : '';
        if (ctx.endpoint) {
            this.logger.debug(
                `=> Send '${ctx.eventName}' event ${requestID}to '${ctx.nodeID}' node` +
                    (groups ? ` in '${groups.join(', ')}' group(s)` : '') +
                    '.',
            );
        } else {
            this.logger.debug(
                `=> Send '${ctx.eventName}' event ${requestID}to '${groups!.join(', ')}' group(s).`,
            );
        }

        return this.send(this.packetFactory.event(ctx), ctx.locals.gateway).catch((err) => {
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

    public sendChannelEvent(ctx: Context, raw: any) {
        const requestID = ctx.requestID ? "with requestID '" + ctx.requestID + "' " : '';
        if (ctx.endpoint) {
            this.logger.debug(`=> Send channel event ${requestID}to '${ctx.nodeID}' node.`);
        }

        return this.send(this.packetFactory.channelEvent(ctx, raw), ctx.locals.gateway).catch(
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
            ctx.locals.resolve(
                this.packetFactory.info(
                    nodeID,
                    this.broker.getLocalNodeInfo(),
                    this.sidecar.registry.getNodeList(),
                ),
            );
        } catch (error) {
            this.logger.error(`Unable to send INFO packet to '${nodeID}' node.`, error);

            this.broker.broadcastLocal('$transit.error', {
                error,
                module: 'transit',
                type: 'FAILED_SEND_INFO_PACKET',
            });
        }
    }

    public requestHeartbeat(nodeID: string, gateway: Gateway) {
        this.logger.debug(`=> Send heartbeat request to ${nodeID} node.`);
        return this.send(this.packetFactory.requestHeartbeat(nodeID), gateway);
    }

    public discoverNode(nodeID: string, gateway: Gateway) {
        return this.send(this.packetFactory.discover(nodeID), gateway);
    }

    public discoverNodeServices(nodeID: string, gateway: Gateway) {
        return this.send(this.packetFactory.discoverServices(nodeID), gateway);
    }

    private send(packet: Packet, gateway: Gateway) {
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
