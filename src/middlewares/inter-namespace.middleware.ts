import type { BrokerOptions, GenericObject, Middleware, ServiceBroker } from 'moleculer';

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
                const brokerOpts = {
                    ...nsOpts.brokerOptions,
                    ...broker.options,
                    nodeID: `${ns}-api-${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`,
                } as BrokerOptions;
                brokerOpts.middlewares = [];
                // @ts-expect-error
                const brokerService = new thisBroker.constructor(brokerOpts);

                nsOpts.servicesPath?.forEach((path) => brokerService.loadService(path));

                brokers[ns] = brokerService;
            }
        },

        async started() {
            thisBroker.logger.warn('Start inter namespace broker...');
            return Promise.all(Object.values(brokers).map(async (b) => b.start()));
        },

        async stopped() {
            thisBroker.logger.warn('Stop inter namespace broker...');
            return Promise.all(Object.values(brokers).map(async (b) => b.stop()));
        },

        call(next: (actionName: string, params: any, options: GenericObject) => any) {
            return function (actionName: string, params: any, options = {}) {
                if (isString(actionName) && actionName.includes('@')) {
                    const [action, namespace] = actionName.split('@');

                    if (brokers[namespace]) {
                        // @ts-expect-error
                        const { ctx, parentCtx, ...others } = options;
                        thisBroker.logger.warn(
                            'Call inter namespace broker...',
                            actionName,
                            params,
                            others,
                        );
                        return brokers[namespace].call(action, params, options);
                    }

                    if (namespace === thisBroker.namespace) {
                        return next(action, params, options);
                    }

                    throw new Error(`Unknown namespace: ${namespace}`);
                }

                return next(actionName, params, options);
            };
        },
    };
}
