import { Channel } from '@moleculer/channels/types/src/index';
import { mkdirSync } from 'fs';
import kleur from 'kleur';
import { Level } from 'level';
import _ from 'lodash';
import { ActionHandler, Context, LoggerInstance, ServiceBroker, ServiceSchema } from 'moleculer';
import path from 'path';

import { Gateway, NodeGateway } from '../gateway';
import { InfoPayload } from '../packet';
import SidecarService from '../services/sidecar.service';
import { getRootDir } from '../uitls';
import { Node } from './node';
import { NodeCatalog } from './node-catalog';

export default class SidecarRegistry {
    private dbPath: string;
    private db!: Level<string, InfoPayload>;
    private pendingWrites: Promise<any>[] = [];

    private opts: {
        heartbeatInterval: number | null;
        heartbeatTimeout: number | null;

        disableHeartbeatChecks: boolean;
        disableOfflineNodeRemoving: boolean;
        cleanOfflineNodesTimeout: number | null;
    };

    private beatsPending = false;

    private heartbeatTimer: NodeJS.Timeout | null;
    private checkNodesTimer: NodeJS.Timeout | null;
    private offlineTimer: NodeJS.Timeout | null;

    public sidecar: SidecarService;
    public broker: ServiceBroker;
    public logger: LoggerInstance;

    public nodes: NodeCatalog;

    private initialized: boolean;

    constructor(sidecar: SidecarService) {
        this.dbPath = path.join(process.env.DATA ?? path.join(getRootDir(), 'data'), 'registry');
        mkdirSync(this.dbPath, { recursive: true });

        this.sidecar = sidecar;
        this.broker = this.sidecar.broker;
        this.logger = sidecar.broker.getLogger('sidecar-registry');

        this.opts = _.defaultsDeep(
            {},
            {},
            {
                heartbeatInterval: null,
                heartbeatTimeout: null,

                disableHeartbeatChecks: false,
                disableOfflineNodeRemoving: false,
                cleanOfflineNodesTimeout: 10 * 60, // 10 minutes
            },
        );

        // Timer variables
        this.heartbeatTimer = null;
        this.checkNodesTimer = null;
        this.offlineTimer = null;

        this.initialized = false;

        this.nodes = new NodeCatalog(
            this,
            this.sidecar.broker,
            (nodeID: string, node: Node | undefined) => {
                if (!this.initialized) {
                    return;
                }
                if (node === undefined) {
                    const promise = this.db
                        .del(nodeID)
                        .then(() => {
                            this.logger.warn(`Node '${nodeID}' deleted from database.`);
                        })
                        .catch((err) => {
                            this.logger.error(err);
                        });
                    this.pendingWrites.push(promise);
                } else if (node.rawInfo) {
                    const promise = this.db
                        .put(nodeID, node.rawInfo)
                        .then(() => {
                            this.logger.warn(`Node '${nodeID}' saved to database.`);
                        })
                        .catch((err) => {
                            this.logger.error(err);
                        });
                    this.pendingWrites.push(promise);
                }
            },
        );
    }

    public async init() {
        // Create a database
        this.db = new Level(this.dbPath, { valueEncoding: 'json' });

        this.logger.info('Sidecar registry initializing');
        const pendingPromises = [];
        for await (const [nodeID, infoPayload] of this.db.iterator()) {
            if (this.nodes.has(nodeID)) {
                this.logger.error(`Detected duplicated node ${nodeID}. Skip it...`);
                continue;
            }
            this.logger.warn(`Loading node '${nodeID}' from database.`);
            const promise = this.nodes.processNodeInfo(infoPayload);
            pendingPromises.push(promise);
        }
        const count = await Promise.allSettled(pendingPromises).then(
            (result) => result.filter((r) => r.status === 'fulfilled').length,
        );
        this.initialized = true;
        this.logger.info(`Sidecar registry initialized with ${count} nodes.`);

        this.startHeartbeatTimers();
    }

    public async stop() {
        if (this.pendingWrites.length) {
            await Promise.all(this.pendingWrites);
        }
        this.db.close();
    }

    // Heartbeat

    private startHeartbeatTimers() {
        this.stopHeartbeatTimers();

        if (this.opts.heartbeatInterval && this.opts.heartbeatInterval > 0) {
            // HB timer
            const time =
                this.opts.heartbeatInterval * 1000 + (Math.round(Math.random() * 1000) - 500); // random +/- 500ms
            this.heartbeatTimer = setInterval(() => this.beat(), time);
            this.heartbeatTimer.unref();
        }

        if (this.opts.heartbeatTimeout && this.opts.heartbeatTimeout > 0) {
            // Check expired heartbeats of remote nodes timer
            this.checkNodesTimer = setInterval(
                () => this.checkRemoteNodes(),
                this.opts.heartbeatTimeout * 1000,
            );
            this.checkNodesTimer.unref();
        }

        if (this.opts.cleanOfflineNodesTimeout && this.opts.cleanOfflineNodesTimeout > 0) {
            // Clean offline nodes timer
            this.offlineTimer = setInterval(() => this.checkOfflineNodes(), 60 * 1000); // 1 min
            this.offlineTimer.unref();
        }
    }

    private stopHeartbeatTimers() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        if (this.checkNodesTimer) {
            clearInterval(this.checkNodesTimer);
            this.checkNodesTimer = null;
        }

        if (this.offlineTimer) {
            clearInterval(this.offlineTimer);
            this.offlineTimer = null;
        }
    }

    private async beat() {
        if (this.beatsPending) {
            this.logger.debug('Beats are already pending. Skip it...');
            return;
        }
        this.beatsPending = true;
        const pendingPromises = [];
        for (const node of this.nodes.toArray()) {
            if (!node.gateway) {
                continue;
            }
            pendingPromises.push(this.sidecar.transit.requestHeartbeat(node.id, node.gateway));
        }
        await Promise.allSettled(pendingPromises);
        this.beatsPending = false;
    }

    private checkRemoteNodes() {
        if (this.opts.disableHeartbeatChecks || !this.opts.heartbeatTimeout) {
            return;
        }

        const now = Math.round(process.uptime());
        for (const node of this.nodes.toArray()) {
            if (!node.available || !node.gateway) {
                continue;
            }
            if (!node.lastHeartbeatTime) {
                // Not received the first heartbeat yet
                node.lastHeartbeatTime = now;
                continue;
            }

            if (now - node.lastHeartbeatTime > this.opts.heartbeatTimeout) {
                this.logger.warn(`Heartbeat is not received from '${node.id}' node.`);
                this.nodes.disconnected(node.id, true);
            }
        }
    }

    private checkOfflineNodes() {
        if (this.opts.disableOfflineNodeRemoving || !this.opts.cleanOfflineNodesTimeout) {
            return;
        }

        const now = Math.round(process.uptime());
        for (const node of this.nodes.toArray()) {
            if (!node.available || !node.gateway) {
                continue;
            }
            if (!node.lastHeartbeatTime) {
                // Not received the first
                node.lastHeartbeatTime = now;
                continue;
            }

            if (now - node.lastHeartbeatTime > this.opts.cleanOfflineNodesTimeout) {
                this.logger.warn(
                    `Removing offline '${node.id}' node from registry because it hasn't submitted heartbeat signal for 10 minutes.`,
                );
                this.nodes.delete(node.id);
            }
        }
    }

    public heartbeatReceived(nodeID: string, payload: any) {
        const node = this.nodes.get(nodeID);
        if (node && node.gateway) {
            if (!node.available) {
                // Reconnected node. Request a fresh INFO
                this.sidecar.transit.discoverNode(nodeID, node.gateway);
            } else {
                if (payload.seq != null && node.seq !== payload.seq) {
                    // Some services changed on the remote node. Request a new INFO
                    this.sidecar.transit.discoverNode(nodeID, node.gateway);
                } else if (
                    payload.instanceID != null &&
                    !node.instanceID?.startsWith(payload.instanceID)
                ) {
                    // The node has been restarted. Request a new INFO
                    this.sidecar.transit.discoverNode(nodeID, node.gateway);
                } else {
                    node.heartbeat();
                }
            }
        } else {
            // Unknow node. Cannot do anything (don't know wich gateway to use)
        }
    }

    public processNodeInfo(payload: InfoPayload) {
        return this.nodes.processNodeInfo(payload);
    }

    public getNodeInfo(nodeID: string) {
        return this.nodes.get(nodeID);
    }

    public unregisterServicesByNode(nodeID: string) {
        const services = this.broker.registry.services.list({
            onlyLocal: true,
            skipInternal: true,
            grouping: true,
        });
        for (const service of services) {
            if (service.metadata.$sidecarNodeID !== nodeID) {
                continue;
            }
            this.logger.info(kleur.yellow().bold(`Destroying '${service.fullName}' service`));
            this.broker.destroyService(service.fullName);
        }
    }

    public async registerServices(node: Node, gateway: NodeGateway) {
        const services = await this.sidecar.transit.discoverNodeServices(node.id, gateway);
        for (const svc of services) {
            const service = this.sidecar.broker.getLocalService(svc.fullName);
            if (service) {
                await this.sidecar.broker.destroyService(svc.fullName);
            }

            const serviceSchema = this.convertSidecarService(node, svc);
            this.logger.info(
                kleur.yellow().bold(`Register new '${serviceSchema.name}' service...`),
            );
            this.sidecar.broker.createService(serviceSchema);
        }
    }

    /**
     * Get list of registered nodes
     *
     * @param {object} opts
     * @returns
     * @memberof Registry
     */
    getNodeList(opts: Parameters<typeof this.nodes.list>[0] = {}) {
        return this.nodes.list(opts);
    }

    /**
     * Get list of registered nodes
     *
     * @param {object} opts
     * @returns
     * @memberof Registry
     */
    getServiceList() {
        const services = this.broker.registry.services.list({
            onlyLocal: true,
            skipInternal: true,
            grouping: true,
            withActions: true,
            withEvents: true,
        });
        const result = [];
        for (const service of services) {
            result.push(service);
        }
        return result;
    }

    private convertSidecarService(node: Node, service: ServiceSchema) {
        const gateway = new Gateway(node.gateway!);

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
                let newAction = _.cloneDeep(action);
                newAction.handler = (ctx: Context) => {
                    ctx.endpoint = { node: { gateway } } as any;
                    ctx.action!.handler = action.handler as unknown as ActionHandler;
                    return this.sidecar.transit.request(ctx);
                };
                schema.actions[actionName] = newAction;
            }
        }

        if (schema.events) {
            for (const [eventName, event] of Object.entries(schema.events)) {
                if (typeof event === 'function') {
                    continue;
                }
                let newEvent = _.cloneDeep(event);
                newEvent.handler = (ctx: Context) => {
                    ctx.endpoint = { node: { gateway } } as any;
                    return this.sidecar.transit.sendEvent(event.handler as unknown as string, ctx);
                };
                schema.events[eventName] = newEvent;
            }
        }

        if (schema.channels) {
            for (const [channelName, channel] of Object.entries(schema.channels) as [
                string,
                Channel,
            ][]) {
                if (typeof channel === 'function') {
                    continue;
                }
                let newChannel = _.cloneDeep(channel);
                newChannel.handler = (ctx: Context, raw: unknown) => {
                    ctx.endpoint = { node: { gateway } } as any;
                    return this.sidecar.transit.sendChannelEvent(
                        channel.handler as unknown as string,
                        ctx,
                        raw,
                    );
                };
                schema.channels[channelName] = newChannel;
            }
        }

        schema.hooks = {};

        return schema;
    }
}
