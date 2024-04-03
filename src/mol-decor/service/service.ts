import { Service, ServiceHooks, ServiceSchema, ServiceSettingSchema } from 'moleculer';
import { inherits } from 'node:util';

import { getMetadata, getMetadataKeys, setMetadata } from '../utils';

/* -------------------------------------------- types ------------------------------------------- */

export interface ServiceDependency {
    name: string;
    version?: string | number;
}

export interface ServiceOptions<S> {
    name?: string;
    version?: string | number;
    settings?: S & ServiceSettingSchema;
    dependencies?: string | ServiceDependency | Array<string | ServiceDependency>;
    metadata?: any;
    mixins?: Array<Partial<ServiceSchema> | ServiceConstructor<any>>;
    hooks?: ServiceHooks;

    [name: string]: any;
}

export interface ServiceConstructor<S> {
    new (...args: any[]): Service<S>;
}

export type ServiceDecorator = <S, T extends ServiceConstructor<S>>(constructor: T) => T;

/* ------------------------------------------- methods ------------------------------------------ */

export function isServiceClass<S>(constructor: any): constructor is ServiceConstructor<S> {
    return typeof constructor === 'function' && Service.isPrototypeOf(constructor);
}

export function getServiceInnerSchema<S>(
    constructor: ServiceConstructor<S>,
): Partial<ServiceSchema<S>> {
    if (!isServiceClass(constructor)) {
        throw TypeError('Class must extend Service');
    }

    const serviceSchema: Partial<ServiceSchema<S>> = {};

    const keys = getMetadataKeys(constructor.prototype, 'service');
    keys.forEach(({ key, metadata }) => (serviceSchema[key] = metadata));

    return serviceSchema;
}

export function getServiceSchema<S>(constructor: ServiceConstructor<S>): ServiceSchema<S> {
    if (!isServiceClass(constructor)) {
        throw TypeError('Class must extend Service');
    }

    return (
        getMetadata(constructor.prototype, 'schema', 'service') ||
        getServiceInnerSchema(constructor)
    );
}

export function convertServiceMixins<S>(schema: ServiceSchema<S>) {
    if (!schema.mixins) return;

    const convertMixins = <S>(mixins: Array<Partial<ServiceSchema<S>> | ServiceConstructor<S>>) => {
        return mixins.map((mixin) => {
            const convertedMixin = isServiceClass<S>(mixin) ? getServiceSchema<S>(mixin) : mixin;
            if (convertedMixin.mixins) {
                convertedMixin.mixins = convertMixins(convertedMixin.mixins);
            }
            return convertedMixin;
        });
    };

    schema.mixins = convertMixins(schema.mixins);
}

type InstanceGenericType<T extends abstract new (...args: any) => Service<any>> =
    T extends abstract new (...args: any) => Service<infer R> ? R : any;

export function MoleculerService<
    T extends ServiceConstructor<any>,
    S extends InstanceGenericType<T>,
>(options: ServiceOptions<S> = {}) {
    return (constructor: T): T => {
        if (!isServiceClass<S>(constructor)) {
            throw TypeError('Class must extend Service');
        }

        let schema: ServiceSchema<S> = getMetadata(constructor.prototype, 'schema', 'service');

        if (!schema) {
            // prepare defaults
            const defaults = {
                name: constructor.name,
                ...options,
            };

            // get schema
            schema = {
                ...defaults,
                ...getServiceInnerSchema(constructor),
            };

            // convert mixins
            convertServiceMixins(schema);

            setMetadata(constructor.prototype, 'schema', schema, 'service');
        }

        return class extends constructor {
            constructor(...args: any[]) {
                super(...args);
                this.parseServiceSchema(schema);
            }
        };
    };
}
