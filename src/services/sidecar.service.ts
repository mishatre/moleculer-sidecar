import kleur from 'kleur';
import _ from 'lodash';
import {
    ActionEndpoint,
    Context,
    Endpoint,
    Errors,
    Service as MoleculerService,
    ServiceSchema,
} from 'moleculer';

import pkgJSON from '../../package.json';
import { Gateway } from '../gateway.js';
import sidecarApiGatewayMixin from '../mixins/sidecarApiGatewayMixin.js';
import sidecarAuthorizeMixin from '../mixins/sidecarAuthorizeMixin';
import {
    MoleculerAction as Action,
    MoleculerMethod as Method,
    MoleculerService as Service,
    MoleculerServiceCreated as ServiceCreated,
    MoleculerServiceStarted as ServiceStarted,
    MoleculerServiceStopped as ServiceStopped,
} from '../mol-decor';
import { RawPacket } from '../packet';
import SidecarRegistry, { NodeInfo } from '../registry/registry';
import { SidecarTransit } from '../transit.js';

export type NodeGateway = {
    endpoint: string;
    port: number;
    useSSL: boolean;
    path?: string;
    auth?:
        | {
              accessToken?: string;
          }
        | { username: string; password: string };
};

export type ServicePublication = {
    publishServices: true;
    namespace: string;
    gateway: NodeGateway;
};

function wrapResponse(error?: Errors.MoleculerError, result?: any) {
    return {
        error,
        result,
    };
}

@Service({
    name: '$sidecar',
    version: pkgJSON.version,
    mixins: [sidecarAuthorizeMixin, sidecarApiGatewayMixin],

    metadata: {
        $category: 'Moleculer sidecar service',
        $description: 'Unoficial Moleculer sidecar implementation',
        $official: false,
        $package: [],
    },

    // dependencies: [
    //     "$nodes",
    //     "$auth"
    // ],

    settings: {
        $noVersionPrefix: true,

        // Exposed port
        port: process.env.SIDECAR_PORT ?? 5103,

        // If set to true, it will log 4xx client errors, as well
        log4XXResponses: true,

        authorization: true,
    },
})
export default class SidecarService extends MoleculerService {
    private transit!: SidecarTransit;
    private registry!: SidecarRegistry;

    @Action({
        name: 'incomingMessage',
        params: {
            cmd: 'string',
            packet: 'object',
        },
        tracing: {
            tags: {
                params: ['packet.type', 'packet.target'],
            },
        },
        visibility: 'private',
    })
    public incomingMessage(ctx: Context<{ cmd: string; packet: RawPacket }>) {
        const { cmd, packet } = ctx.params;
        return this.transit.messageHandler(cmd, packet, ctx);
    }

    @Action({
        name: 'gateway.request',
        params: {
            action: 'string',
            nodeID: 'string|optional',
            gateway: 'object|optional',
        },
        tracing: {
            tags: {
                params: ['action', 'nodeID', 'gateway.entrypoint', 'gateway.path'],
            },
        },
    })
    public async requestGateway(
        ctx: Context<{ action: string; nodeID: string; gateway?: NodeGateway }>,
    ) {
        let gateway;
        if (ctx.params.gateway) {
            gateway = new Gateway(ctx.params.gateway);
        } else if (ctx.params.nodeID) {
            const nodeGateway = await this.actions.getGatewayByNodeID<NodeGateway>({
                nodeID: ctx.params.nodeID,
            });
            if (nodeGateway) {
                gateway = new Gateway(nodeGateway);
            }
        }
        if (!gateway) {
            // Throw error
            return;
        }

        const endpoint = {
            broker: null,
            action: {
                name: ctx.params.action,
            },
            id: ctx.params.nodeID,
            name: `${ctx.params.nodeID}:${ctx.params.action}`,
            node: {
                gateway,
            },
        };

        const requestCtx = this.broker.ContextFactory.create(
            this.broker,
            endpoint as unknown as ActionEndpoint,
        );
        requestCtx.setEndpoint(endpoint as unknown as ActionEndpoint);
        requestCtx.nodeID = ctx.params.nodeID;
        const response = await this.transit.request(requestCtx);
        return response;
    }

    // Sidecar moleculer API actions

    // External node actions

    @Action({
        name: 'nodes.register',
        params: {
            node: {
                type: 'object',
                optional: false,
                strict: true,
                props: {
                    instanceID: 'string',
                    metadata: 'any',
                    gateway: {
                        type: 'object',
                        optional: true,
                        props: {
                            endpoint: 'string',
                            port: 'number|optional',
                            useSSL: 'boolean',
                            path: 'string|optional',
                            auth: {
                                type: 'object',
                                optional: true,
                                props: {
                                    username: 'string|optional',
                                    password: 'string|optional',
                                    accessToken: 'string|optional',
                                },
                            },
                        },
                    },
                    client: {
                        type: 'object',
                        optional: false,
                        props: {
                            type: 'string',
                            version: 'string',
                            moduleType: 'string',
                            langVersion: 'string',
                            langCompatibilityVersion: 'string',
                        },
                    },
                },
            },
        },
    })
    public async nodesRegisterAction(ctx: Context<{ node: NodeInfo }>) {
        const nodeID = ctx.nodeID;

        if (!nodeID) {
            throw new Errors.MoleculerError('Node ID is required');
        }

        if (this.registry.getNodeInfo(nodeID)) {
            throw new Errors.MoleculerError(`Node with id - "${nodeID}" already registered`);
        }

        const nodeInfo = _.cloneDeep(ctx.params.node);

        if (nodeInfo.gateway) {
            try {
                // Test gateway connection
                const gatewayResponse = (await this.actions['gateway.request'](
                    {
                        action: '$node.registration',
                        gateway: nodeInfo.gateway,
                    },
                    { parentCtx: ctx },
                )) as {
                    success: boolean;
                    accessToken?: string;
                };
                if (!gatewayResponse.success) {
                    throw new Errors.MoleculerError(
                        `Node - "${nodeID}" gateway returned invalid response`,
                    );
                }
                if ('accessToken' in gatewayResponse && gatewayResponse.accessToken) {
                    nodeInfo.gateway.auth = {
                        accessToken: gatewayResponse.accessToken,
                    };
                }
            } catch (error: unknown) {
                if (error instanceof Errors.MoleculerError) {
                    throw error;
                } else if (error instanceof Error) {
                    throw new Errors.MoleculerError(error.message, 500, '', error);
                }
                throw new Errors.MoleculerError('Failed to send request to node', 500, '', error);
            }
        }

        const node = this.registry.addNode(nodeID, nodeInfo);

        return {
            success: true,
            node,
        };
    }

    @Action({
        name: 'nodes.remove',
        params: {},
    })
    public async nodesRemoveAction(ctx: Context<{ nodeID: string }>) {
        const { nodeID } = ctx.params;

        // const services = await ctx.call<ServiceSchema[], { nodeID: string }>("$nodes.getNodeServices", { nodeID });
        // for (const schema of services) {
        //     const service = this.broker.getLocalService({
        //         name: schema.name,
        //         version: schema.version,
        //     });
        //     if (service) {
        //         await this.broker.destroyService(service);
        //     }
        //     await ctx.call("$nodes.removeService", { nodeID, serviceName: service.name, version: service.version });
        // }

        // await ctx.call("$nodes.removeNode", { nodeID });
        return true;
    }

    @Action({
        name: 'nodes.list',
        params: {},
    })
    public async nodesListAction(ctx: Context) {
        return this.registry.getNodeList();
    }

    // External services actions

    @Action({
        name: 'services.publish',
        params: {
            schema: 'object',
        },
    })
    public async servicesPublishAction(ctx: Context<{ schema: ServiceSchema }>) {
        const nodeID = ctx.nodeID!;
        const { schema } = ctx.params;

        const node = this.registry.nodes.get(nodeID);
        if (!node) {
            throw new Errors.MoleculerError(`Node with id - "${nodeID}" not registered`, 404);
        } else if (!node.gateway) {
            throw new Errors.MoleculerError('Node does not allow external calls', 500);
        }

        const fullName = this.broker.ServiceFactory.getVersionedFullName(
            schema.name,
            schema.version,
        );

        if (this.registry.services.has(fullName, nodeID)) {
            throw new Errors.MoleculerError(`Service "${fullName}" already registered`, 409);
        }

        this.registry.nodes.registerService(nodeID, schema);

        return {
            success: true,
        };
    }

    @Action({
        name: 'services.remove',
        params: {
            nodeID: 'string',
            serviceName: 'string',
            serviceVersion: 'string|optional',
        },
    })
    public async servicesRemoveAction(
        ctx: Context<{ nodeID: string; serviceName: string; serviceVersion?: string }>,
    ) {
        const { nodeID, serviceName, serviceVersion } = ctx.params;

        const service = this.broker.getLocalService({
            name: serviceName,
            version: serviceVersion,
        });

        if (!service) {
            await ctx.call('$nodes.removeService', {
                nodeID,
                serviceName: serviceName,
                version: serviceVersion,
            });
            throw new Errors.MoleculerError('Service not published');
        }

        try {
            await this.broker.destroyService(service);
        } catch (err) {
            this.logger.error(err);
            throw err;
        }

        return await ctx.call('$nodes.removeService', {
            nodeID,
            serviceName: serviceName,
            version: serviceVersion,
        });
    }

    @Action({
        name: 'services.update',
        params: {},
    })
    public async servicesUpdateAction(ctx: Context) {}

    @Action({
        name: 'services.list',
        params: {},
    })
    public async servicesListAction(ctx: Context) {
        const nodeID = ctx.nodeID;
        return this.registry.getServiceList(nodeID!);
    }

    @Method
    protected reformatError(error: any) {
        return wrapResponse(error);
    }

    @ServiceStarted
    public async started() {
        await this.registry.init();
        this.logger.warn('Sidecar service started');
        // const servicesByNodes = await this.broker.call<{ [key: string]: ServiceSchema[] }>("$nodes.getServices");
        // for (const nodeID of Object.keys(servicesByNodes)) {
        //     const serviceSchemas = servicesByNodes[nodeID];
        //     for (const schema of serviceSchemas) {
        //         this.actions.registerNodeService({ nodeID, schema });
        //     }
        // }
    }

    @ServiceCreated
    public async created() {
        this.transit = new SidecarTransit(this.broker, this);
        this.registry = new SidecarRegistry(this.broker, this);
    }

    /**
     * Service stopped lifecycle event handler
     */
    @ServiceStopped
    public stopped() {}
}
