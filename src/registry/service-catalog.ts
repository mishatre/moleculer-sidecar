import _ from 'lodash';
import {
    ActionSchema,
    EventSchema,
    LoggerInstance,
    ServiceBroker,
    ServiceSchema,
    ServiceSettingSchema,
} from 'moleculer';

import { Node } from './node';
import SidecarRegistry from './registry';
import { ServiceItem } from './service';

type ListItem = {
    name: string;
    version: string | number | undefined;
    fullName: string;
    settings: ServiceSettingSchema | undefined;
    metadata: Record<string, any>;
    available: boolean;

    actions?: Record<string, ActionSchema>;
    events?: Record<string, EventSchema>;

    nodeID?: string;
    nodes?: string[];
};

export class ServiceCatalog {
    private registry: SidecarRegistry;
    private broker: ServiceBroker;
    private logger: LoggerInstance;

    private services: Map<string, ServiceItem>;

    constructor(registry: SidecarRegistry, broker: ServiceBroker) {
        this.registry = registry;
        this.broker = broker;
        this.logger = registry.logger;

        this.services = new Map();
    }

    private getKey(fullName: string, nodeID: string) {
        return `${nodeID}:${fullName}`;
    }

    private fromKey(key: string) {
        const ix = key.indexOf(':');
        if (ix < 0) {
            throw new Error(`Invalid key: ${key}`);
        }
        return {
            nodeID: key.substring(ix - 1),
            fullName: key.substring(ix + 1),
        };
    }

    /**
     * Add a new service
     *
     */
    public add(node: Node, service: ServiceSchema) {
        const item = new ServiceItem(node, service);
        this.services.set(this.getKey(service.fullName, node.id), item);
        return item;
    }

    /**
     * Check the service is exist
     *
     * @param {String} fullName
     * @param {String} nodeID
     * @returns
     * @memberof ServiceCatalog
     */
    public has(fullName: string, nodeID: string) {
        return this.services.has(this.getKey(fullName, nodeID));
    }

    /**
     * Get a service by fullName & nodeID
     *
     */
    public get(fullName: string, nodeID: string) {
        return this.services.get(this.getKey(fullName, nodeID));
    }

    /**
     * Get a filtered list of services with actions
     *
     */
    public list<
        A extends boolean,
        E extends boolean,
        G extends boolean,
        T extends Omit<
            ListItem,
            | (A extends true ? '' : 'actions')
            | (E extends true ? '' : 'events')
            | (G extends true ? 'nodeID' : 'nodes')
        >,
    >(
        nodeID: string,
        {
            onlyAvailable = false,
            withActions = false as A,
            withEvents = false as E,
            grouping = false as G,
        }: {
            onlyAvailable?: boolean;
            withActions?: A;
            withEvents?: E;
            grouping?: G;
        } = {},
    ): T[] {
        let res = [];
        for (const service of this.services.values()) {
            if (service.node.id !== nodeID) {
                continue;
            }
            if (onlyAvailable && !service.node.available) {
                continue;
            }

            let item: ListItem | undefined;
            if (grouping) {
                item = res.find((svc) => svc.fullName == service.fullName);
            }

            if (!item) {
                item = {
                    name: service.name,
                    version: service.version,
                    fullName: service.fullName,
                    settings: service.settings,
                    metadata: service.metadata,

                    available: service.node.available,

                    ...(grouping ? { nodes: [service.node.id] } : { nodeID: service.node.id }),
                };

                if (withActions) {
                    item.actions = {};
                    for (const action of Object.values(service.actions)) {
                        if (action.protected) continue;
                        item.actions[action.name] = _.omit(action, [
                            'handler',
                            'remoteHandler',
                            'service',
                        ]);
                    }
                }

                if (withEvents) {
                    item.events = {};
                    for (const event of Object.values(service.events)) {
                        item.events[event.name] = _.omit(event, [
                            'handler',
                            'remoteHandler',
                            'service',
                        ]);
                    }
                }

                res.push(item);
            } else if (item.nodes?.indexOf(service.node.id) === -1) {
                item.nodes.push(service.node.id);
            }
        }

        return res as unknown as T[];
    }

    /**
     * Remove all endpoints by nodeID
     *
     */
    removeAllByNodeID(nodeID: string) {
        for (const serviceKey of this.services.keys()) {
            const { nodeID: serviceNodeID } = this.fromKey(serviceKey);
            if (serviceNodeID == nodeID) {
                const service = this.services.get(serviceKey);
                // this.registry.actions.removeByService(service);
                // this.registry.events.removeByService(service);
                this.remove(serviceKey, nodeID);
            }
        }
    }

    /**
     * Remove endpoint by fullName & nodeID
     *
     */
    remove(fullName: string, nodeID: string) {
        const service = this.get(fullName, nodeID);
        if (service) {
            // this.registry.actions.removeByService(service);
            // this.registry.events.removeByService(service);

            this.services.delete(this.getKey(fullName, nodeID));
        }
    }
}
