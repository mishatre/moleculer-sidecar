import { mkdirSync } from 'fs';
import kleur from 'kleur';
import { Level } from 'level';
import _ from 'lodash';
import { Context, LoggerInstance, ServiceBroker, ServiceSchema } from 'moleculer';
import path from 'path';

import { SidecarTransit } from '../transit';
import { getRootDir } from '../uitls';
import { Node, NodeInfo } from './node';
import { NodeCatalog } from './node-catalog';
import { ServiceCatalog } from './service-catalog';

export default class SidecarRegistry {
    private dbPath: string;
    private db!: Level<string, NodeInfo>;
    private pendingWrites: Promise<any>[] = [];

    public broker: ServiceBroker;
    public transit: SidecarTransit;
    public logger: LoggerInstance;

    public nodes: NodeCatalog;

    private initialized: boolean;
    public services: ServiceCatalog;

    constructor(broker: ServiceBroker, service: ServiceSchema) {
        this.dbPath = path.join(process.env.DATA ?? path.join(getRootDir(), 'data'), 'registry');
        mkdirSync(this.dbPath, { recursive: true });

        this.broker = broker;
        this.logger = broker.getLogger('sidecar-registry');
        this.transit = service.transit;

        this.initialized = false;

        this.nodes = new NodeCatalog(this, this.broker, (nodeID: string, node: Node) => {
            if (!this.initialized || !node.rawInfo) {
                return;
            }
            const promise = this.db
                .put(nodeID, {
                    ...node.rawInfo,
                    services: node.services,
                })
                .then(() => {
                    this.logger.warn(`Node '${nodeID}' saved to database.`);
                })
                .catch((err) => {
                    this.logger.error(err);
                });
            this.pendingWrites.push(promise);
        });

        this.services = new ServiceCatalog(this, this.broker);
        // this.actions;
        // this.events;
    }

    public async init() {
        // Create a database
        this.db = new Level(this.dbPath, { valueEncoding: 'json' });

        this.logger.info('Sidecar registry initializing');
        let count = 0;
        for await (const [nodeID, nodeInfo] of this.db.iterator()) {
            if (this.nodes.has(nodeID)) {
                this.logger.error(`Detected duplicated node ${nodeID}. Skip it...`);
                continue;
            }
            this.logger.warn(`Loading node '${nodeID}' from database.`);
            this.nodes.processNodeInfo(nodeID, nodeInfo);
            count++;
        }
        this.initialized = true;
        this.logger.info(`Sidecar registry initialized with ${count} nodes.`);
    }

    public async stop() {
        if (this.pendingWrites.length) {
            await Promise.all(this.pendingWrites);
        }
        this.db.close();
    }

    public getNodeInfo(nodeID: string) {
        return this.nodes.get(nodeID);
    }

    public addNode(nodeID: string, nodeInfo: NodeInfo) {
        return this.nodes.processNodeInfo(nodeID, nodeInfo);
    }

    public registerServices(node: Node, serviceList: ServiceSchema[]) {
        for (let svc of serviceList) {
            this.nodes.registerService(node.id, svc);
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
    getServiceList(nodeID: string, opts: Parameters<typeof this.nodes.list>[0] = {}) {
        return this.services.list(nodeID, opts);
    }
}
