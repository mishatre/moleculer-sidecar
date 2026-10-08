import kleur from 'kleur';
import _ from 'lodash';
import { action, created, defineSettings, method, service, started, stopped } from 'moldecor';
import type { Context, ServiceSchema } from 'moleculer';
import DbService from 'moleculer-db';
import SequelizeDbAdapter from 'moleculer-db-adapter-sequelize';
import Sequelize from 'sequelize';
import { NotFoundError, ServiceUnavailableError } from '../errors.js';
import ApiGateway from '../mixins/api-gateway.js';
import AuthorizeMixin from '../mixins/authorize.js';
import { Errors, Service as MoleculerService } from '../runtime/cjs-interop.js';
import { getPgliteConnection } from '../runtime/pglite.js';
import { type ServerSettings, serverSettings } from '../server.js';
import type { AuthInfo, ConnectionInfo } from '../types.js';

interface Settings extends ServerSettings {
    //
    path: string;
}

interface RegisterParams {
    connection: ConnectionInfo & AuthInfo;
    handler: string;
}

interface RemoteCallParams {
    action: string;
    params?: any;
    nodeInfo: ConnectionInfo & AuthInfo;
}

interface DBTable {
    id: string;
    endpoint: string;
    port: string;
    useSSL: boolean;
    path: string;
    authType: AuthTypes;
    username: string;
    password: string;
}

enum AuthTypes {
    UsingPassword = 'UsingPassword',
    UsingAccessToken = 'UsingAccessToken',
    NoAuth = 'NoAuth',
}

interface UnregisterParams {
    publicationID: 'string';
}

const settings = defineSettings<Partial<Settings>>({
    ...serverSettings,

    // Sidecar path
    path: '/sidecar',
});

@service({
    name: '$sidecar',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    settings,

    dependencies: ['$sidecar.auth', '$sidecar.utils'],

    mixins: [AuthorizeMixin, ApiGateway, DbService],
    adapter: new SequelizeDbAdapter({
        // The database is the shared PGlite instance (src/runtime/pglite.ts); one
        // pool connection per service, budgeted by the socket's maxConnections.
        dialect: 'postgres',
        host: getPgliteConnection().host,
        port: getPgliteConnection().port,
        database: 'postgres',
        username: 'postgres',
        password: 'postgres',
        logging: false,
        pool: { max: 1 },
    }),

    model: {
        name: 'publication',
        define: {
            id: {
                type: Sequelize.UUID,
                primaryKey: true,
            },
            endpoint: Sequelize.STRING,
            port: Sequelize.STRING,
            useSSL: Sequelize.BOOLEAN,
            path: Sequelize.STRING,
            authType: Sequelize.ENUM(...Object.values(AuthTypes)),
            username: Sequelize.STRING,
            password: Sequelize.TEXT,
        },
        options: {
            schema: 'publication',
        },
    },

    // Disable all moleculer-db actions
    actions: {
        find: false,
        count: false,
        list: false,
        create: false,
        insert: false,
        get: false,
        update: false,
        remove: false,
    },
})
export default class SidecarService extends MoleculerService<typeof settings> {
    private adapter!: SequelizeDbAdapter & { db: Sequelize.Sequelize };
    declare protected send: ApiGateway['send'];

    @action({
        name: 'register',
        params: {
            connection: 'any',
        },
        visibility: 'protected',
    })
    protected async register(ctx: Context<RegisterParams>) {
        const { connection } = ctx.params;

        const services = await this.call<ServiceSchema[]>('$internal.services', {}, connection, {
            ctx,
        });

        for (const serviceInfo of services) {
            try {
                const serviceSchema = this.convertSidecarService(serviceInfo.Schema, connection);
                serviceSchema.metadata['$publicationID'] = connection.id;
                this.logger.info(
                    kleur.yellow().bold(`Register new '${serviceSchema.name}' service...`),
                );
                this.broker.createService(serviceSchema);
            } catch (error) {
                this.logger.error(error);
            }
        }

        const foundPublication = await this.adapter.findById(connection.id);
        if (foundPublication) {
            return;
        }

        await this.adapter.insert(this.connectionInfoToDbItem(connection));

        return null;
    }

    @action({
        name: 'unregister',
        params: {
            publicationID: 'string',
        },
        visibility: 'protected',
    })
    protected async unregister(ctx: Context<UnregisterParams>) {
        const { publicationID } = ctx.params;
        const services = this.broker.registry.services.list({
            onlyLocal: true,
            skipInternal: true,
            grouping: true,
        });
        const promises = [];
        for (const service of services) {
            if (service.metadata.$publicationID !== publicationID) {
                continue;
            }
            this.logger.info(kleur.yellow().bold(`Destroying '${service.fullName}' service`));
            promises.push(this.broker.destroyService(service.fullName));
        }
        await Promise.allSettled(promises);
        await this.adapter.removeById(publicationID);
    }

    @action({
        name: 'updateService',
        params: {
            publicationID: 'string',
            service: 'string',
        },
    })
    public async updateService(ctx: Context<{ publicationID: string; service: string }>) {
        const item = (await this.adapter.findById(ctx.params.publicationID)) as DBTable;
        const connection = this.adaptDbConnectionInfo(item);

        const publicationServices = await this.call<ServiceSchema[]>(
            '$internal.services',
            {},
            connection,
            {
                ctx,
            },
        );

        const service = this.broker.registry.services
            .list({
                onlyLocal: true,
                skipInternal: true,
                grouping: true,
            })
            .find(
                (service: { metadata: Record<string, unknown> }) =>
                    service.metadata.$publicationID === ctx.params.publicationID,
            );
        if (service) {
            this.logger.info(kleur.yellow().bold(`Destroying '${service.fullName}' service`));
            await this.broker.destroyService(service.fullName);
        }

        const svc = publicationServices.find((service) => service.fullName === ctx.params.service);
        if (!svc) {
            throw new NotFoundError('SERVICE_NOT_FOUND');
        }
        const serviceSchema = this.convertSidecarService(svc, connection);
        serviceSchema.metadata['$publicationID'] = connection.id;
        this.logger.info(kleur.yellow().bold(`Register new '${serviceSchema.name}' service...`));
        this.broker.createService(serviceSchema);
    }

    @action({
        name: 'callLocalNode',
        params: {
            action: 'string',
            params: 'any|optional',
            nodeInfo: 'any',
        },
        visibility: 'public',
    })
    protected callLocalNode(ctx: Context<RemoteCallParams>) {
        return this.call(ctx.params.action, ctx.params.params, ctx.params.nodeInfo);
    }

    @method
    private async call<R>(
        actionName: string,
        params: object,
        connection: ConnectionInfo & AuthInfo,
        opts = {},
    ) {
        const ctx = this.broker.ContextFactory.create(
            this.broker,
            null as any,
            params,
            opts,
        ) as Context<RegisterParams, object, { connection: ConnectionInfo & AuthInfo }>;

        ctx.action = { name: actionName };

        ctx.locals = {
            connection,
        };
        return (await this.send<R>(ctx)) as R;
    }

    @method
    protected async request(ctx: Context) {
        if (ctx.action) {
            const endpoint = this.broker.findNextActionEndpoint(
                ctx.action as unknown as string,
                ctx.options,
                ctx,
            );
            if (endpoint instanceof Error) {
                if (endpoint instanceof Errors.ServiceNotFoundError) {
                    throw new ServiceUnavailableError();
                }
                throw endpoint;
            }
            ctx.endpoint = endpoint;
            ctx.action = endpoint;

            if (ctx.options.parentCtx!.span) {
                ctx.options.parentCtx!.span.name = `action '${ctx.action.name}' [${
                    ctx.options.parentCtx!.span.name
                }]`;
            }

            // Call the action
            // `stream` is this sidecar's own field and moleculer's typings omit
            // `opts.ctx` (which broker.call does read) — same object, same keys.
            const callOpts = {
                ...ctx.options,
                stream: (ctx as Context & { stream?: boolean }).stream,
                ctx,
            };

            return await ctx.call(endpoint as unknown as string, ctx.params, callOpts);
        } else if (ctx.eventType) {
            if (ctx.eventType === 'emit') {
                if (ctx.options.parentCtx!.span) {
                    ctx.options.parentCtx!.span.name = `event '${ctx.eventName}' [${
                        ctx.options.parentCtx!.span.name
                    }]`;
                }

                this.broker.emit(ctx.eventName!, ctx.params, {
                    ...ctx.options,
                    groups: ctx.eventGroups,
                });
            } else if (ctx.eventType === 'broadcast') {
                this.broker.broadcast(ctx.eventName!, ctx.params, {
                    groups: ctx.eventGroups,
                });
            }
        }
        return undefined;
    }

    @method
    private convertSidecarService(service: ServiceSchema, connection: any) {
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
                const newAction = _.cloneDeep(action);
                newAction.handler = (ctx: Context) => {
                    ctx.locals = {
                        handler: action.handler,
                        connection,
                    };
                    return this.send(
                        ctx as Context<
                            RegisterParams,
                            object,
                            { connection: ConnectionInfo & AuthInfo }
                        >,
                    );
                };
                schema.actions[actionName] = newAction;
            }
        }

        if (schema.events) {
            for (const [eventName, event] of Object.entries(schema.events)) {
                if (typeof event === 'function') {
                    continue;
                }
                const newEvent = _.cloneDeep(event);
                newEvent.handler = (ctx: Context) => {
                    ctx.locals = {
                        handler: event.handler,
                        connection,
                    };
                    return this.send(
                        ctx as Context<
                            RegisterParams,
                            object,
                            { connection: ConnectionInfo & AuthInfo }
                        >,
                    ) as any;
                };
                schema.events[eventName] = newEvent;
            }
        }

        // if (schema.channels) {
        //     for (const [channelName, channel] of Object.entries(schema.channels) as [
        //         string,
        //         Channel,
        //     ][]) {
        //         if (typeof channel === 'function') {
        //             continue;
        //         }
        //         let newChannel = _.cloneDeep(channel);
        //         newChannel.handler = (ctx: Context, raw: unknown) => {
        //             ctx.locals = {
        //                 handler: channel.handler,
        //                 gateway,
        //             };
        //             return this.sidecar.transit.sendChannelEvent(ctx, raw);
        //         };
        //         schema.channels[channelName] = newChannel;
        //     }
        // }

        schema.hooks = {};

        return schema;
    }

    @method
    private async initPublications() {
        const count = await this.adapter.count();
        if (count === 0) {
            return;
        }

        const items = (await this.adapter.find({})) as DBTable[];
        for (const item of items) {
            try {
                const connection = this.adaptDbConnectionInfo(item);
                const services = await this.call<ServiceSchema[]>(
                    '$internal.services',
                    {},
                    connection,
                    {},
                );

                for (const serviceInfo of services) {
                    this.createService(serviceInfo.Schema, connection);
                }
            } catch (error) {
                this.logger.warn(`Couldn't init ${item.id} publication`);
            }
        }
    }

    @method
    private createService(svc: ServiceSchema, connection: ConnectionInfo & AuthInfo) {
        try {
            const serviceSchema = this.convertSidecarService(svc, connection);
            serviceSchema.metadata['$publicationID'] = connection.id;
            this.logger.info(
                kleur.yellow().bold(`Register new '${serviceSchema.name}' service...`),
            );
            this.broker.createService(serviceSchema);
        } catch (error) {
            this.logger.error(error);
        }
    }

    @method
    private adaptDbConnectionInfo(item: DBTable): ConnectionInfo & AuthInfo {
        let auth;
        if (item.authType === AuthTypes.UsingAccessToken) {
            auth = {
                token: item.password,
            };
        } else if (item.authType === AuthTypes.UsingPassword) {
            auth = {
                username: item.username,
                password: item.password,
            };
        }

        return {
            id: item.id,
            endpoint: item.endpoint,
            port: item.port,
            useSSL: item.useSSL,
            path: item.path,
            auth,
        };
    }

    @method
    private connectionInfoToDbItem(connection: ConnectionInfo & AuthInfo): DBTable {
        const { auth, ...rest } = connection;
        const item = Object.assign({}, rest) as DBTable;
        if (!auth) {
            item.authType = AuthTypes.NoAuth;
        } else if ('token' in auth) {
            item.authType = AuthTypes.UsingAccessToken;
            item.password = auth.token;
        } else if ('username' in auth) {
            item.authType = AuthTypes.UsingPassword;
            item.username = auth.username;
            item.password = auth.password;
        }

        return item;
    }

    @created
    public created() {}

    @started
    public async started() {
        await this.initPublications();
    }

    @stopped
    public stopped() {}
}
