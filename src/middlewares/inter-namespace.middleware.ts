import _ from 'lodash';
import {
    BrokerOptions,
    CallMiddlewareHandler,
    GenericObject,
    Middleware,
    ServiceBroker,
} from 'moleculer';

function isString(str: unknown): str is string {
    if (str != null && typeof str.valueOf() === 'string') {
        return true;
    }
    return false;
}

export default function InterNamespaceMiddleware(
    opts: Array<{ brokerOptions: BrokerOptions; servicesPath?: string[] }>,
): Middleware {
    if (!Array.isArray(opts)) {
        throw new Error('Must be an Array');
    }

    let thisBroker: ServiceBroker;
    const brokers: Record<string, ServiceBroker> = {};

    return {
        created(broker: ServiceBroker) {
            thisBroker = broker;
            for (const nsOpts of opts) {
                const ns = nsOpts?.brokerOptions.namespace ?? 'N/A';
                thisBroker.logger.warn(`Create inter namespace broker for '${ns} namespace...'`);
                const brokerOpts = _.defaultsDeep(
                    {},
                    nsOpts.brokerOptions,
                    {
                        nodeID: `${ns}-api-${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`,
                    },
                    broker.options,
                ) as BrokerOptions;
                brokerOpts.middlewares = [];

                const brokerService = new ServiceBroker(brokerOpts);

                nsOpts.servicesPath?.forEach((path) => brokerService.loadService(path));

                brokers[ns] = brokerService;
            }
        },

        async started() {
            return Promise.all(Object.values(brokers).map(async (b) => b.start()));
        },

        async stopped() {
            return Promise.all(Object.values(brokers).map(async (b) => b.stop()));
        },

        call(next: CallMiddlewareHandler) {
            return function (actionName: string, params: GenericObject, options: GenericObject) {
                if (isString(actionName) && actionName.includes('@')) {
                    const [action, namespace] = actionName.split('@');
                    if (brokers[namespace]) {
                        thisBroker.logger.warn(
                            `Call '${actionName}' action in '${namespace}' namespace...`,
                        );
                        return brokers[namespace].call(action, params, options);
                    } else if (namespace === thisBroker.namespace) {
                        return next(action, params, options);
                    }
                    throw new Error(`Unknown namespace: ${namespace}`);
                }
                return next(actionName, params, options);
            };
        },
    };
}
