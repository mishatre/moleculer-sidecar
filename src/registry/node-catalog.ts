import _ from 'lodash';
import { LoggerInstance, ServiceBroker } from 'moleculer';

import { InfoPayload } from '../packet.js';
import { Node } from './node.js';
import SidecarRegistry from './registry.js';

export class NodeCatalog {
    private registry: SidecarRegistry;
    private broker: ServiceBroker;
    private logger: LoggerInstance;
    private nodes: Map<string, Node>;

    private onNodeUpdate: (nodeID: string, node: Node | undefined) => void;

    constructor(
        registry: SidecarRegistry,
        broker: ServiceBroker,
        onNodeUpdate: (nodeID: string, node: Node | undefined) => void,
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
    public delete(id: string) {
        this.nodes.delete(id);
        this.onNodeUpdate(id, undefined);
        return;
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
    async processNodeInfo(sender: string, payload: InfoPayload) {
        const nodeID = sender;

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

        const needRegister = node.update(payload, isReconnected);

        // Refresh services if 'seq' is greater or it is a reconnected node
        if (needRegister && node.gateway) {
            await this.registry.registerServices(node);
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

    /**
     * Disconnected a node
     *
     * @param {String} nodeID
     * @param {Boolean} isUnexpected
     * @memberof NodeCatalog
     */
    disconnected(nodeID: string, isUnexpected = false) {
        let node = this.get(nodeID);
        if (node && node.available) {
            node.disconnected(isUnexpected);

            this.registry.unregisterServicesByNode(node.id);

            this.broker.broadcastLocal('$sidecar-node.disconnected', {
                node,
                unexpected: !!isUnexpected,
            });

            // this.registry.updateMetrics();

            if (isUnexpected) {
                this.logger.warn(`Node '${node.id}' disconnected unexpectedly.`);
            } else {
                this.delete(nodeID);
                this.logger.info(`Sidecar node '${node.id}' disconnected.`);
            }
        }
    }

    /**
     * Get a node list
     *
     * @param {Object} {onlyAvailable = false, withServices = false}
     * @returns
     * @memberof NodeCatalog
     */
    list({ onlyAvailable = true }) {
        let res: Partial<Node>[] = [];
        this.nodes.forEach((node) => {
            if (onlyAvailable && !node.available) {
                return;
            }
            res.push(_.omit(node, ['rawInfo', 'gateway.auth']));
        });

        return res;
    }

    /**
     * Get a copy from node list.
     */
    toArray() {
        return Array.from(this.nodes.values());
    }
}
