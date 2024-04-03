import {
    ActionCacheOptions,
    ActionHooks,
    ActionParams,
    ActionVisibility,
    BrokerCircuitBreakerOptions,
    BulkheadOptions,
    Context,
    FallbackHandler,
    RestSchema,
    RetryPolicyOptions,
    Service,
    TracingActionOptions,
} from 'moleculer';

import { getMetadata, setMetadata } from '../utils';

export interface ActionOptions {
    name?: string;
    rest?: RestSchema | string | string[];
    visibility?: ActionVisibility;
    params?: ActionParams;
    service?: Service;
    cache?: boolean | ActionCacheOptions;
    timeout?: number;
    tracing?: boolean | TracingActionOptions;
    bulkhead?: BulkheadOptions;
    circuitBreaker?: BrokerCircuitBreakerOptions;
    retryPolicy?: RetryPolicyOptions;
    fallback?: string | FallbackHandler;
    hooks?: ActionHooks;

    [key: string]: any;
}

type MethodDecorator<T> = (
    target: Object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
) => TypedPropertyDescriptor<T> | void;

export function MoleculerAction<P = {}, T = (ctx: Context<P>) => void>(
    options?: ActionOptions,
): MethodDecorator<T> {
    return (target, propertyKey, descriptor) => {
        const handler = descriptor.value;

        if (!handler || typeof handler !== 'function') {
            throw new TypeError('An action must be a function');
        }

        const keyName = propertyKey.toString();
        const actions = getMetadata(target, 'actions', 'service') || {};

        const defaults: ActionOptions = {
            name: keyName,
            visibility: 'public',
        };

        const opts: ActionOptions = { ...defaults, ...options };

        actions[opts.name] = { handler, ...opts };

        setMetadata(target, 'actions', actions, 'service');
        return descriptor;
    };
}
