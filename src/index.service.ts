import _ from 'lodash';
import { Action, Created, Method, Service, Started, Stopped } from 'moldecor';
import { ActionSchema, Context, Errors, Service as MoleculerService } from 'moleculer';
import EventEmitter from 'node:events';

import pkgJSON from '../package.json';
import { Gateway } from './gateway.js';
import sidecarApiGatewayMixin, {
    SidecarApiGatewayMixinSettings,
} from './mixins/sidecarApiGatewayMixin.js';
import sidecarAuthorizeMixin from './mixins/sidecarAuthorizeMixin.js';
import SidecarRegistry from './registry/registry.js';
import { SidecarTransit } from './transit.js';

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

    settings: {
        $noVersionPrefix: true,

        // Exposed port
        port: process.env.SIDECAR_PORT ?? 5103,

        // If set to true, it will log 4xx client errors, as well
        log4XXResponses: true,

        authorization: true,

        rootUrl: process.env.SIDECAR_ROOT_URL ?? '/v1/message',
    },
})
export default class SidecarService extends MoleculerService<SidecarApiGatewayMixinSettings> {
    public transit!: SidecarTransit;
    public registry!: SidecarRegistry;

    private internalEvents: EventEmitter = new EventEmitter();

    @Action({
        name: 'gateway.request',
        params: {
            action: {
                type: 'object',
                string: true,
                optional: false,
                props: {
                    name: 'string',
                    handler: 'string',
                },
            },
            nodeID: 'string|optional',
            gateway: 'object|optional',
        },
        tracing: {
            tags: {
                params: ['handler', 'nodeID', 'gateway.entrypoint', 'gateway.path'],
            },
        },
    })
    public requestGateway(
        ctx: Context<{
            action: { name: string; handler: string };
            nodeID: string;
            gateway?: NodeGateway;
        }>,
    ) {
        let gateway;
        if (ctx.params.gateway) {
            gateway = new Gateway(ctx.params.gateway);
        } else if (ctx.params.nodeID) {
            const nodeInfo = this.registry.getNodeInfo(ctx.params.nodeID);
            if (nodeInfo && nodeInfo.gateway) {
                gateway = new Gateway(nodeInfo.gateway);
            }
        }
        if (!gateway) {
            // Throw error
            throw new Error('NO_GATEWAY');
        }

        const requestCtx = this.broker.ContextFactory.create(this.broker);
        requestCtx.endpoint = { node: { gateway } } as any;
        requestCtx.nodeID = ctx.params.nodeID;
        requestCtx.action = ctx.params.action as unknown as ActionSchema;
        return this.transit.request(requestCtx);
    }

    // Sidecar moleculer API actions

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
        return this.registry.getServiceList();
    }

    @Method
    protected reformatError(error: any) {
        return wrapResponse(error);
    }

    @Started
    public async started() {
        await this.registry.init();
        this.logger.warn('Sidecar service started');
    }

    @Created
    public async created() {
        this.registry = new SidecarRegistry(this);
        this.transit = new SidecarTransit(this);
        this.internalEvents.on('message', this.transit.incomingMessage.bind(this.transit));
    }

    /**
     * Service stopped lifecycle event handler
     */
    @Stopped
    public stopped() {}
}
