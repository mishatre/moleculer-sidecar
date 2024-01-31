
import Moleculer, { Context, Service as MoleculerService, ServiceSchema, ActionSchema, Errors, ActionHandler, ServiceSettingSchema, EventSchema, ServiceEventHandler, ServiceSyncLifecycleHandler } from 'moleculer';
import { Service, Action, Method } from 'moleculer-decorators';
import ApiGateway, { GatewayResponse, IncomingRequest, Route } from 'moleculer-web';
import _ from 'lodash';
import kleur from 'kleur';
import { parseStringPromise } from 'xml2js';
import { join as joinPath } from 'node:path/posix';

import verifySigV4 from './aws-signature.js';

const WebErrors = ApiGateway.Errors;

interface RegisterSidecarNodeParameters {
    connection: {
        endpoint: string,
        port: number,
        useSSL: boolean,
        accessToken: string
    },
    name: string,
    gateway: string,
}

@Service({
    name: "$sidecar",
    mixins: [ApiGateway],

    settings: {
        port: process.env.SIDECAR_PORT != null ? process.env.SIDECAR_PORT : 5103,
		path: "/v1",

        routes: [{
            path: "/",

            mappingPolicy: "restrict",

            bodyParsers: {
                json: true
            },

            aliases: {
                // Registry-access endpoints
                "GET /registry/nodes": "$node.list",
                "GET /registry/services": "$node.services",
                "GET /registry/actions": "$node.actions",
                "GET /registry/events": "$node.events",
            },

            autoAliases: true,
            authorization: true,

        }],
    }
})
class SidecarService extends MoleculerService {

    private registeredNodes: string[] = [];

    private services: Map<string, MoleculerService> = new Map;

    @Action({
        name: "registerSidecarNode",
        params: {
            connection: {
                type: "object",
                params: {
                    endpoint: "string|no-empty",
                    port: "number|no-empty",
                    useSSL: "boolean|no-empty",
                    accessToken: "string|no-empty"
                }
            },
            name: "string|no-empty",
            gateway: "string|no-empty",  
        }
    })
    public async registerSidecarNode(ctx: Context<RegisterSidecarNodeParameters>) {
        const { connection, name, gateway } = ctx.params;
    
        // if (this.registeredNodes.includes(nodeId)) {
        //     throw new Errors.RequestRejectedError(
        //         `NodeID - ${nodeId} already registered`
        //     );
        // }

        let options = {
            headers: {
                "Authorization": "Bearer " + connection.accessToken
            }
        };
        const endpointUrl = new URL(`${connection.useSSL ? "https" : "http"}://${connection.endpoint}`);
        const discoverUrl = new URL(joinPath(gateway, "discover"), endpointUrl);
        const requestUrl = new URL(joinPath(gateway, "request"), endpointUrl);

        const contextPayload = this.extractContext(ctx);
        const { result, error } = await this.callExternalNode<{ services: [] }>(discoverUrl, contextPayload, options.headers);

        if (error) {
            throw error;
        }

        console.log({ result, error });
        const registeredServices: string[] = [];

        for (let service of result!.services as { actions?: ActionSchema[], events?: EventSchema[], created?: string, started?: string, stopped?: string }[]) {

            const schema = _.cloneDeep(_.omit(service, "actions,events")) as ServiceSchema;
            
            // 1. Check the service is exist
            let svc = this.broker.getLocalService({
                name: schema.name,
                version: schema.version
            });

            // 2.   If yes, destroy
            if (svc) {
                this.logger.info(`Destroy previous '${schema.name}' service...`);
                await this.broker.destroyService(svc);
            }
         
            // 3. Convert the schema, fulfill the action/event handlers
            this.logger.info(kleur.yellow().bold(`Create new '${schema.name}' service...`));
            
            // if (service.created) {
            //     const self = this;     
            //     schema.created = function handler() {
            //         self.callExternalNode(gatewayURL, {
            //             lifecycle: {
            //                 name: service.created,
            //                 serviceName: schema.name
            //             },
            //             serviceName: schema.name
            //         }, options.headers);
            //     };
            // }

            if (service.started) {
                const self = this;     
                schema.started = async function handler() {
                    const { error } = await self.callExternalNode(requestUrl, {
                        action: {
                            name: "started",
                            handler: service.started
                        }
                    }, options.headers);

                    if (error) {
                        throw error;
                    }

                };
            }

            if (service.stopped) {
                const self = this;     
                schema.stopped = async function handler() {
                    const { error } = await self.callExternalNode(requestUrl, {
                        action: {
                            name: "stopped",
                            handler: service.stopped
                        }
                    }, options.headers);

                    if (error) {
                        throw error;
                    }

                };
            }

            if (service.actions) {
                let actions: Moleculer.ServiceActionsSchema<ServiceSettingSchema> = {};
                for (const action of service.actions) {

                    const handler = action.handler as unknown as string;

                    let newAction = _.cloneDeep(action);
                    newAction.handler = this.generateActionHandler(newAction, handler, requestUrl, options.headers);

                    actions[action.name!] = newAction;

                }
                schema.actions = actions;
            }

            if(service.events) {

                let events: Moleculer.ServiceEvents<ServiceSettingSchema> = {};
                for (const event of service.events) {
                    
                    let newEvent = _.cloneDeep(event);
                    newEvent.serviceName = schema.name;
                    newEvent.handler = this.generateEventHandler(newEvent, requestUrl, options.headers);

                    events[newEvent.name!] = newEvent;

                }
                schema.events = events;

            }
 
            schema.channels = {};
            schema.hooks = {};

            svc = this.broker.createService(schema);
            registeredServices.push(svc.fullName);

        }

        this.registeredNodes.push(name);

        const nodeID = this.broker.nodeID;
        
        return { success: true, registeredServices, nodeID }

    }

    @Action({
        name: "callAction",
        params: {
            action: "string|no-empty|trim",
            params: "any|optional",
            meta: "object|optional",
            options: "object|optional"
        },
        rest: {
            method: "POST",
            basePath: "/",
            path: "/call/:action"
        }
    })
    public async callAction(ctx: Context<{ action: string, params: any, meta: any, options: any }, { $statusCode: number }>) {

        const { action, params, meta, options } = ctx.params;
        try {
            const result = await ctx.call(
                action,
                params != null ? params : {},
                {
                    meta: meta,
                    ...(options || {})
                }
            );

            return {
                result,
                meta: ctx.meta
            };
        } catch (error: any) {
            ctx.meta.$statusCode = error.code || 500;

            return {
                error: _.pick(error, [
                    "name",
                    "message",
                    "code",
                    "type",
                    "stack",
                    "data",
                    "nodeID"
                ]),
                meta: ctx.meta
            };
        }
    }

    @Action({
        name: "mCallAction",
        params: {
            def: "any|optional",
            meta: "object|optional",
            options: "object|optional"
        },
        rest: {
            method: "POST",
            basePath: "/",
            path: "/mcall"
        }
    })
    public async mCallAction(ctx: Context<{ def: any, meta: any, options: any }, { $statusCode: number }>) {
        
        const { def, meta, options } = ctx.params;
        try {
            const result = await ctx.mcall(
                def,
                {
                    meta: meta,
                    ...(options || {})
                }
            );

            return {
                result,
                meta: ctx.meta
            };
        } catch (error: any) {
            ctx.meta.$statusCode = error.code || 500;

            return {
                error: _.pick(error, [
                    "name",
                    "message",
                    "code",
                    "type",
                    "stack",
                    "data",
                    "nodeID"
                ]),
                meta: ctx.meta
            };
        }

    }

    @Action({
        name: "emitEvent",
        params: {
            event: "string|no-empty|trim",
            data: "any|optional",
            meta: "object|optional",
            options: "object|optional"
        },
        rest: {
            method: "POST",
            basePath: "/",
            path: "/emit/:event"
        }
    })
    public async emitEvent(ctx: Context<{ event: string, data?: any, meta?: {}, options?: {} }, { $statusCode: number }>) {

        const { event, data, meta, options } = ctx.params;
        try {
            await ctx.emit(
                event,
                data,
                {
                    meta: meta,
                    ...(options || {})
                }
            );

            return {
                result: true,
                meta: ctx.meta
            };
        } catch (error: any) {
            ctx.meta.$statusCode = error.code || 500;

            return {
                error: _.pick(error, [
                    "name",
                    "message",
                    "code",
                    "type",
                    "stack",
                    "data",
                    "nodeID"
                ]),
                meta: ctx.meta
            };
        }

    }

    @Action({
        name: "broadcastEvent",
        params: {
            event: "string|no-empty|trim",
            params: "any|optional",
            meta: "object|optional",
            options: "object|optional"
        },
        rest: {
            method: "POST",
            basePath: "/",
            path: "/broadcast/:event"
        }
    })
    public async broadcastEvent(ctx: Context<{ event: string, params?: any, meta?: {}, options?: {} }, { $statusCode: number }>) {

        const { event, params, meta, options } = ctx.params;
        try {
            await ctx.broker.broadcast(
                event,
                params,
                {
                    meta: meta,
                    ...(options || {})
                }
            );

            return {
                result: true,
                meta: ctx.meta
            };
        } catch (error: any) {
            ctx.meta.$statusCode = error.code || 500;

            return {
                error: _.pick(error, [
                    "name",
                    "message",
                    "code",
                    "type",
                    "stack",
                    "data",
                    "nodeID"
                ]),
                meta: ctx.meta
            };
        }

    }

    @Action({
        name: "broadcastLocalEvent",
        params: {
            event: "string|no-empty|trim",
            params: "any|optional",
            meta: "object|optional",
            options: "object|optional"
        },
        rest: {
            method: "POST",
            basePath: "/",
            path: "/broadcastlocal/:event"
        }
    })
    public async broadcastLocalEvent(ctx: Context<{ event: string, params?: any, meta?: {}, options?: {} }, { $statusCode: number }>) {

        const { event, params, meta, options } = ctx.params;
        try {
            await ctx.broker.broadcastLocal(
                event,
                params,
                {
                    meta: meta,
                    ...(options || {})
                }
            );

            return {
                result: true,
                meta: ctx.meta
            };
        } catch (error: any) {
            ctx.meta.$statusCode = error.code || 500;

            return {
                error: _.pick(error, [
                    "name",
                    "message",
                    "code",
                    "type",
                    "stack",
                    "data",
                    "nodeID"
                ]),
                meta: ctx.meta
            };
        }

    }

    @Method
    private generateActionHandler(action: ActionSchema, handler: string, url: URL, headers: any): ActionHandler<any>  {
        return async (ctx: Context) => {
            
            const contextPayload = this.extractContext(ctx);
            contextPayload.action = {
                ...action,
                handler: handler as any
            };
            const { result, error, meta } = await this.callExternalNode(url, contextPayload, headers);

            if (meta) {
                // Merge the received meta into "ctx.meta"
                Object.assign(ctx.meta, meta);
            }

            if (error) {
                throw error;
            }

            return result;

        }
    }

    @Method
    private generateEventHandler(event: EventSchema, url: URL, headers: any): ServiceEventHandler {
        return async (ctx: Context) => {
            
            const contextPayload = this.extractContext(ctx);
            contextPayload.event = event;
            (contextPayload as any).serviceName = event.serviceName;
            const { meta } = await this.callExternalNode(url, contextPayload, headers);

            if (meta) {
                // Merge the received meta into "ctx.meta"
                Object.assign(ctx.meta, meta);
            }

        }
    }

    @Method
    private async callExternalNode<T extends Object>(url: URL, payload: any, additionalHeaders: any): Promise<{ result?: T, error?: any, meta?: any }> {

        let headers = new Headers;
        headers.set("content-type", "application/json");
        for ( const key in additionalHeaders) {
            headers.set(key, additionalHeaders[key]);
        }

        let response = null;
        try {
            response = await fetch(url, {
                method: "POST",    
                headers,
                body: payload ? JSON.stringify(payload) : undefined
            });

            let responseData: { result?: T, error?: any, meta?: any };
            const contentType = response.headers.get("content-type");
            if (contentType) {
                if (contentType.startsWith("application/json")) {
                    responseData = await response.json() as { result?: T, error?: any, meta?: any };
                } else if (contentType.startsWith("application/xml")) {
                    // Handle 1C error
                    const xmlText = await response.text();
                    const xmlData = await parseStringPromise(xmlText);
                    const errorDescription = xmlData.exception.descr[0]._;
                    const errorStack = xmlData.exception.creationStack[0]._;
                    const error = new Errors.MoleculerError(errorDescription, response.status, response.statusText);
                    error.stack = errorStack;
                    responseData = {
                        error
                    };
                } else {
                    responseData = {
                        error: {
                            data: await response.text(),
                        }
                    }
                }
            } else {
                responseData = {
                    error: {
                        data: await response.text()
                    }
                };
            }

            if (!responseData || responseData.error) {
                let err;
                if (responseData.error) {
                    const { message, code, data, type, stack } = responseData.error;
                    err = new Errors.MoleculerError(message, code, type, data);
                    err.stack = stack;
                } else {
                    err = new Errors.MoleculerError("Something happened", response.status, response.statusText);
                }

                throw err;
            }

            return responseData;

        } catch(error) {
            return {
                result: undefined,
                error: error,
            }
        }

    }

    @Method
    private extractContext(ctx: Context) {
        return {

            action: _.pick(ctx.action, [
                "name",
                "params",
                "handlerName",
                "rawName"
            ]),

            ackID: ctx.ackID,
            cachedResult: ctx.cachedResult,
            caller: ctx.caller,
            event: ctx.event,
            eventGroups: ctx.eventGroups,
            eventName: ctx.eventName,
            eventType: ctx.eventType,
            id: ctx.id,
            level: ctx.level,
            meta: ctx.meta,
            needAck: ctx.needAck,
            nodeID: ctx.nodeID,
            options: {
                timeout: ctx.options.timeout
            },
            params: ctx.params,
            parentID: ctx.parentID,
            requestID: ctx.requestID,

        };
    }

    @Method
    private async authorize(ctx: Context, route: Route, req: IncomingRequest, res: GatewayResponse): Promise<Context> {
        
        let auth = req.headers["authorization"];
        if (!auth) {
            // No token
            return Promise.reject(
                this.newResponse(new WebErrors.UnAuthorizedError(WebErrors.ERR_NO_TOKEN, null))
            );
        }

        let { success, error } = verifySigV4(req);

        if (error) {
            return Promise.reject(
                this.newResponse(new WebErrors.UnAuthorizedError(WebErrors.ERR_INVALID_TOKEN, error))
            );
        }

        if (success) {
            return Promise.resolve(ctx);
        }

        return Promise.reject(
            this.newResponse(new WebErrors.UnAuthorizedError(WebErrors.ERR_INVALID_TOKEN, error))
        );
    }

    @Method
    private newResponse(error?: Errors.MoleculerError, result?: any ) {
        return {
            error,
            result
        }
    }

    protected async created() {
        this.services = new Map();
    }

}

export default SidecarService;