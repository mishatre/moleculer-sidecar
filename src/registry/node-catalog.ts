import kleur from 'kleur';
import _ from 'lodash';
import { Context, LoggerInstance, ServiceBroker, ServiceSchema } from 'moleculer';

import { Gateway } from '../gateway';
import { Node, NodeInfo } from './node';
import SidecarRegistry from './registry';

export class NodeCatalog {
    private registry: SidecarRegistry;
    private broker: ServiceBroker;
    private logger: LoggerInstance;
    private nodes: Map<string, Node>;

    private onNodeUpdate: (nodeID: string, node: Node) => void;

    constructor(
        registry: SidecarRegistry,
        broker: ServiceBroker,
        onNodeUpdate: (nodeID: string, node: Node) => void,
    ) {
        this.registry = registry;
        this.broker = broker;
        this.logger = registry.logger;

        this.onNodeUpdate = onNodeUpdate;

        this.nodes = new Map();
    }

    /**
     * Add a new node
     *
     * @param {String} id
     * @param {SidecarNode} node
     * @memberof NodeCatalog
     */
    private add(id: string, node: Node) {
        this.nodes.set(id, node);
    }

    /**
     * Delete a node by nodeID
     *
     * @param {String} id
     * @returns
     * @memberof NodeCatalog
     */
    private delete(id: string) {
        return this.nodes.delete(id);
    }

    /**
     * Check a node exist by nodeID
     *
     * @param {String} id
     * @returns
     * @memberof NodeCatalog
     */
    has(id: string) {
        return this.nodes.has(id);
    }

    /**
     * Get a node by nodeID
     *
     * @param {String} id
     * @returns
     * @memberof NodeCatalog
     */
    get(id: string) {
        return this.nodes.get(id);
    }

    /**
     * Get count of all registered nodes
     */
    count() {
        return this.nodes.size;
    }

    /**
     * Process incoming INFO packet payload
     *
     * @param {any} payload
     * @memberof NodeCatalog
     */
    processNodeInfo(nodeID: string, nodeInfo: NodeInfo) {
        let node = this.get(nodeID);
        let isNew = false;
        let isReconnected = false;

        if (!node) {
            node = new Node(nodeID);
            isNew = true;
            this.add(nodeID, node);
        } else if (!node.available) {
            isReconnected = true;
            node.lastHeartbeatTime = Math.round(process.uptime());
            node.available = true;
            node.offlineSince = null;
        }

        const needRegister = node.update(nodeInfo, isReconnected);

        // Refresh services if 'seq' is greater or it is a reconnected node
        if (needRegister && node.services) {
            this.registry.registerServices(node, node.services);
        }

        // Local notifications
        if (isNew) {
            this.broker.broadcastLocal('$sidcar-node.connected', { node, reconnected: false });
            this.logger.info(`Sidecar node '${nodeID}' connected.`);
            // this.registry.updateMetrics();
        } else if (isReconnected) {
            this.broker.broadcastLocal('$sidcar-node.connected', { node, reconnected: true });
            this.logger.info(`Sidecar node '${nodeID}' reconnected.`);
            // this.registry.updateMetrics();
        } else {
            this.broker.broadcastLocal('$sidecar-node.updated', { node });
            this.logger.debug(`Sidecar node '${nodeID}' updated.`);
        }

        this.onNodeUpdate(nodeID, node);

        return node;
    }

    registerService(nodeID: string, svc: ServiceSchema) {
        if (!svc.fullName) {
            svc.fullName = this.broker.ServiceFactory.getVersionedFullName(svc.name, svc.version);
        }

        if (this.registry.services.has(svc.fullName, nodeID)) {
            return false;
        }

        const node = this.get(nodeID);
        if (!node) {
            return false;
        }

        const serviceSchema = this.convertSidecarService(node, svc);
        this.logger.info(kleur.yellow().bold(`Register new '${serviceSchema.name}' service...`));
        this.broker.createService(serviceSchema);

        this.registry.services.add(node, serviceSchema);

        node.services.push(serviceSchema);

        this.onNodeUpdate(nodeID, node);

        return true;
    }

    /**
     * Disconnected a node
     *
     * @param {String} nodeID
     * @param {Boolean} isUnexpected
     * @memberof NodeCatalog
     */
    // disconnected(nodeID, isUnexpected) {
    //     let node = this.get(nodeID);
    //     if (node && node.available) {
    //         node.disconnected(isUnexpected);

    //         this.registry.unregisterServicesByNode(node.id);

    //         this.broker.broadcastLocal('$node.disconnected', { node, unexpected: !!isUnexpected });

    //         this.registry.updateMetrics();

    //         if (isUnexpected) this.logger.warn(`Node '${node.id}' disconnected unexpectedly.`);
    //         else this.logger.info(`Node '${node.id}' disconnected.`);

    //         if (this.broker.transit) this.broker.transit.removePendingRequestByNodeID(nodeID);
    //     }
    // }

    /**
     * Get a node list
     *
     * @param {Object} {onlyAvailable = false, withServices = false}
     * @returns
     * @memberof NodeCatalog
     */
    list({ onlyAvailable = false, withServices = false }) {
        let res: Omit<Node, 'rawInfo' | 'services'>[] = [];
        this.nodes.forEach((node) => {
            if (onlyAvailable && !node.available) {
                return;
            }
            if (withServices) {
                res.push(_.omit(node, ['rawInfo']));
            } else {
                res.push(_.omit(node, ['rawInfo', 'services']));
            }
        });

        return res;
    }

    /**
     * Get a copy from node list.
     */
    toArray() {
        return Array.from(this.nodes.values());
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
                    return this.registry.transit.request(ctx);
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
                    return this.registry.transit.sendEvent(ctx);
                };
                schema.events[eventName] = newEvent;
            }
        }

        schema.channels = {};
        schema.hooks = {};

        return schema;
    }
}
