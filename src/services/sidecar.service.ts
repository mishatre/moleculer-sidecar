
import Moleculer, { Context, Service as MoleculerService, ServiceSchema, ActionSchema, Errors, ActionHandler, ServiceSettingSchema, EventSchema, ServiceEventHandler, ServiceSyncLifecycleHandler } from 'moleculer';
import { Service, Action, Method } from 'moleculer-decorators';
import ApiGateway, { GatewayResponse, IncomingRequest, Route } from 'moleculer-web';
import _ from 'lodash';
import kleur from 'kleur';
import { parseStringPromise } from 'xml2js';
import { join as joinPath } from 'node:path/posix';
import { VerifyRequestParams, VerifyRequestResponse } from './auth.service.js';
import pkgJSON from "../../package.json"

const WebErrors = ApiGateway.Errors;

export type NodeGateway = {
    endpoint: string,
    port: number,
    useSSL: boolean,
    path?: string,
    auth?: {
        accessToken?: string
    } | { username: string, password: string },
}

export type ServicePublication = {
    publishServices: true;
    namespace: string;
    gateway: NodeGateway;
}

export type SidecarNode = {
    nodeID: string;
    nodeType: string;
    version: string;
    servicePublication?: ServicePublication;
    platform: {
        name: string;
        version?: '8.3.23.0000',
        os?: 'Windows 10',
        cpu?: '',
        memory?: '',
    };
}

function wrapResponse(error?: Errors.MoleculerError, result?: any) {
    return {
        error,
        result
    }
}

@Service({
    name: "$sidecar",
    version: pkgJSON.version,
    mixins: [ApiGateway],

    metadata: {
        $category: 'Moleculer sidecar service',
        $description: 'Unoficial Moleculer sidecar implementation',
        $official: false,
        $package: []
    },

    dependencies: [
        "$nodes",
        "$auth"
    ],

    settings: {
        $noVersionPrefix: true,
        log4XXResponses: false,

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

    @Action({
        name: "info"
    })
    public async sidecarInfo(ctx: Context) {
        const data = await ctx.broker.call<ServiceSchema[], { onlyLocal: true }>("$node.services", { onlyLocal: true });

        const sidecarService = data.find(s => s.name === "$sidecar");
        if (!sidecarService) {
            return undefined;
        }
        return _.pick(sidecarService, ["name", "version", "fullName", "metadata", "available"]);
    }

    @Action({
        name: "pingGateway",
        params: {
            gateway: {
                type: "object",
                props: {
                    endpoint: "string",
                    port: "number|optional",
                    useSSL: "boolean",
                    accessToken: "string|optional",
                    username: "string|optional",
                    password: "string|optional",
                }
            }
        },
        rest: {
            method: "GET",
            basePath: "/",
            path: "/pingGateway"
        }
    })
    public async pingGateway(ctx: Context<{ gateway: NodeGateway }>) {
        
        const { gateway } = ctx.params;
        
        const headers = new Headers(); 
        if (gateway.auth) {
            if ('accessToken' in gateway.auth) {
                headers.set("authorization", "Bearer " + gateway.auth.accessToken);
            } else if ('username' in gateway.auth && 'password' in gateway.auth) {
                headers.set("authorization", "Basic " + Buffer.from(gateway.auth.username + ':' + gateway.auth.password).toString('base64'));
            } else {
                throw new Errors.MoleculerError(
                    `Incorrect gateway auth object`
                );
            }
        }
        
        const gatewayResponse = await this.callGateway<"pong">(ctx, gateway, 'ping', {}, headers);
        if (gatewayResponse.error) {
            throw new Errors.MoleculerError("Failed to send request to node", gatewayResponse.error.code, gatewayResponse.error);
        }

        return {
            success: gatewayResponse.result === "pong"
        }

    }

    @Action({
        name: "registerNode",
        params: {
            node: {
                type: "object",
                props: {
                    nodeID: "string",
                    nodeType: "string",
                    version: "string|optional",
                    servicePublication: {
                        type: "object",
                        optional: true,
                        props: {
                            publishServices: "boolean",
                            namespace: "string",
                            gateway: {
                                type: "object",
                                props: {
                                    endpoint: "string",
                                    port: "number|optional",
                                    useSSL: "boolean",
                                    path: "string|optional",
                                    auth: {
                                        type: "object",
                                        props: {
                                            username: "string|optional",
                                            password: "string|optional",
                                            accessToken: "string|optional",
                                        }
                                    }
                                }
                            }
                        }
                    },
                    platform: {
                        type: "object",
                        props: {
                            name: "string",
                            version: "string|optional",
                            os: "string|optional",
                            cpu: "string|optional",
                            memory: "string|optional",
                        }
                    }
                }
            }
        }
    })
    public async registerNode(ctx: Context<{ node: SidecarNode }>) {

        const { node } = _.cloneDeep(ctx.params);

        const nodeAlreadyRegistered = await ctx.call('$nodes.hasNode', { nodeID: node.nodeID });
        if (nodeAlreadyRegistered) {
            throw new Errors.MoleculerError(
                `Node with id - "${node.nodeID}" already registered`
            );
        }

        if (node.servicePublication?.publishServices === true) {
            const { gateway, namespace } = node.servicePublication;
            if (!gateway) {
                throw new Errors.MoleculerError(
                    `To publish services node must provide gateway endpoint`
                );
            }

            if (!namespace) {
                throw new Errors.MoleculerError(
                    `Node must provide namespace.`
                );
            } else {
                const namespaceAlreadyRegistered = await ctx.call('$nodes.hasNamespace', { namespace });
                if (namespaceAlreadyRegistered) {
                    throw new Errors.MoleculerError(
                        `Namespace - "${namespace}" already used by another node`
                    );
                }
            }
            
            const gatewayResponse = await this.sendRequestToNode<{ success: true, accessToken?: string }>(ctx, node, 'authorization', {});
            if (gatewayResponse.error) {
                throw new Errors.MoleculerError("Failed to send request to node", gatewayResponse.error.code, gatewayResponse.error);
            }

            if (!gatewayResponse.result || !("success" in gatewayResponse.result)) {
                throw new Errors.MoleculerError(
                    `Node - "${node.nodeID}" gateway returned invalid response`
                );
            }

            if ('accessToken' in gatewayResponse.result && gatewayResponse.result.accessToken) {
                gateway.auth = {
                    accessToken: gatewayResponse.result.accessToken
                };
                node.servicePublication.gateway = gateway;
            }

        }

        await ctx.call('$nodes.addNode', { node });

        return {
            success: true
        };

    }

    @Action({
        name: 'nodeRegistered',
        params: {
            nodeID: "string"
        }
    })
    public async nodeRegistered(ctx: Context<{ nodeID: string }>) {
        const { nodeID } = ctx.params;
        return await ctx.call("$nodes.hasNode", { nodeID });
    }

    @Action({
        name: 'removeNode',
        params: {
            nodeID: "string"
        }
    })
    public async removeNode(ctx: Context<{ nodeID: string }>) {
        const { nodeID } = ctx.params;

        const services = await ctx.call<ServiceSchema[], { nodeID: string }>("$nodes.getNodeServices", { nodeID });
        for (const schema of services) {
            const service = this.broker.getLocalService({
                name: schema.name, 
                version: schema.version,
            });
            if (service) {
                await this.broker.destroyService(service);
            }
            await ctx.call("$nodes.removeService", { nodeID, serviceName: service.name, version: service.version });
        }

        await ctx.call("$nodes.removeNode", { nodeID });
        return true;
    }

    @Action({
        name: 'publishedServices',
        params: {
            nodeID: "string"
        }
    })
    public async publishedServices(ctx: Context<{ nodeID: string }>) {
        const { nodeID } = ctx.params;
        return await ctx.call("$nodes.getNodeServices", { nodeID });
    }

    @Action({
        name: 'registerNodeService',
        params: {
            nodeID: "string",
            schema: "object"
        }
    })
    public async registerNodeService(ctx: Context<{ nodeID: string, schema: ServiceSchema }>) {
        const { nodeID } = ctx.params;

        const node = await ctx.call<SidecarNode, { nodeID: string }>("$nodes.getNode", { nodeID });
        if (!node) {
            throw new Errors.MoleculerError("Node not found");
        }

        if (!node.servicePublication?.publishServices) {
            throw new Errors.MoleculerError("Node does not allow external calls", 500);
        }

        const originalSchema = ctx.params.schema;
        const schema = _.cloneDeep(_.omit(ctx.params.schema, ["created", "started", "stopped", "deleted", "actions", "events"]));
            
        // 1. Check the service is exist
        let svc = this.broker.getLocalService({
            name: schema.name,
            version: schema.version
        });

        // 2. If yes, return error
        if (svc) {
            throw new Errors.MoleculerError(
                `Service "${schema.name}" already registered`
            )
        }

        const self = this;
         
        // 3. Convert the schema, fulfill the action/event handlers
        this.logger.info(kleur.yellow().bold(`Register new '${schema.name}' service...`));
        if (originalSchema.created) {
            schema.created = function handler() {
                self.sendRequestToNode(ctx, node, "lifecycle", {
                    event: {
                        name: "created",
                        handler: originalSchema.created
                    }
                });
            };
        }

        if (originalSchema.started) { 
            schema.started = function handler() {
                self.sendRequestToNode(ctx, node, "lifecycle", {
                    event: {
                        name: "started",
                        handler: originalSchema.started
                    }
                });
            };
        }

        if (originalSchema.stopped) {
            schema.stopped = function handler() {
                self.sendRequestToNode(ctx, node, "lifecycle", {
                    event: {
                        name: "stopped",
                        handler: originalSchema.stopped
                    }
                });
            };
        }

        if (originalSchema.actions) {
            let actions: Moleculer.ServiceActionsSchema<ServiceSettingSchema> = {};
            for (const action of originalSchema.actions) {
                let newAction = _.cloneDeep(action);
                newAction.handler = async function handler(ctx: Context) {
                    self.sendRequestToNode(ctx, node, "request", {
                        ...self.extractContext(ctx),
                        action: {
                            name: action.name,
                            handler: action.handler
                        }
                    });
                } 
                actions[action.name!] = newAction;
            }
            schema.actions = actions;
        }

        if(originalSchema.events) {
            let events: Moleculer.ServiceEvents<ServiceSettingSchema> = {};
            for (const event of originalSchema.events) {
                let newEvent = _.cloneDeep(event);
                newEvent.serviceName = schema.name;
                newEvent.handler = async function handler(ctx: Context) {
                    self.sendRequestToNode(ctx, node, "event", {
                        ...self.extractContext(ctx),
                        event: {
                            name: event.name,
                            handler: event.handler
                        }
                    });
                }
                events[newEvent.name!] = newEvent;
            }
            schema.events = events;
        }
 
        schema.channels = {};
        schema.hooks = {};

        svc = this.broker.createService(schema);
        try {
            await this.broker.waitForServices(svc.fullName, 20000);
        } catch (err) {
            this.logger.error(err);
            this.broker.destroyService(svc);
            throw err;
        }

        try {
            const success = await ctx.call("$nodes.addService", { nodeID, service: originalSchema });
            return { success };
        } catch (err) {
            this.logger.error(err);
            this.broker.destroyService(svc);
            throw err;
        }
        
    }

    @Action({
        name: "revokeNodeServicePublication",
        params: {
            nodeID: "string",
            serviceName: "string",
            serviceVersion: "string|optional",
        }
    })
    public async revokeNodeServicePublication(ctx: Context<{ nodeID: string, serviceName: string, serviceVersion?: string }>) {
        const { nodeID, serviceName, serviceVersion } = ctx.params;

        const service = this.broker.getLocalService({
            name: serviceName,
            version: serviceVersion
        });

        if (!service) {
            await ctx.call("$nodes.removeService", { nodeID, serviceName: serviceName, version: serviceVersion });
            throw new Errors.MoleculerError("Service not published");
        }

        try {
            await this.broker.destroyService(service);
        } catch (err) {
            this.logger.error(err);
            throw err;
        }

        return await ctx.call("$nodes.removeService", { nodeID, serviceName: serviceName, version: serviceVersion });

    }

    @Action({
        name: "updateServiceSchema",
        params: {
            
        }
    })
    public async updateServiceSchema(ctx: Context) {
        
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

        const isSidecarCall = action.startsWith("$sidecar"); 

        try {
            const result = await ctx.call(
                action,
                params != null ? params : {},
                {
                    meta: meta,
                    ...(options || {}),
                    // Call only to current node
                    nodeID: isSidecarCall ? ctx.broker.nodeID : undefined
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
    private generateEventHandler(event: EventSchema, handler: string, url: URL, headers: any): ServiceEventHandler {
        return async (ctx: Context) => {
            console.log(event);
            const contextPayload = this.extractContext(ctx);
            contextPayload.event = {
                ...event,
                handler: handler as any
            };
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
    private async sendRequestToNode<T>(ctx: Context, node: SidecarNode, command: string, payload: any, additionalHeaders?: Headers) {
        
        if(!node.servicePublication?.publishServices) {
            throw new Errors.MoleculerServerError("Node does not allow external calls", 500);
        }

        if (node.platform.name !== "1С:Предприятия 8") {
            throw new Errors.MoleculerServerError("Sidecar does not support external calls to this platform", 500);
        }

        return this.callGateway<T>(ctx, node.servicePublication.gateway, command, payload, additionalHeaders);
    }

    @Method
    private async callGateway<T>(ctx: Context, gateway: NodeGateway, command: string, payload: any, additionalHeaders?: Headers) {

        const port = gateway.port && gateway.port > 0 ? `:${gateway.port}` : "";

        const base = new URL(`${gateway.useSSL ? "https" : "http"}://${gateway.endpoint}${port}`);
        const url = new URL(joinPath(gateway.path ?? '', '/hs/moleculer/', command), base);

        const headers = new Headers;
        headers.set("content-type", "application/json");
        headers.set("accept", "application/json");

        if (gateway.auth) {
            if ('accessToken' in gateway.auth) {
                headers.set("authorization", "Bearer " + gateway.auth.accessToken);
            } else if ('username' in gateway.auth && 'password' in gateway.auth) {
                headers.set("authorization", "Basic " + Buffer.from(gateway.auth.username + ':' + gateway.auth.password).toString('base64'));
            } else {
                throw new Errors.MoleculerError(
                    `Incorrect gateway auth object`
                );
            }
        }

        additionalHeaders?.forEach((value, key) => headers.set(key, value));

        try {
            const span1 = ctx.startSpan('call-gateway', { 
                tags: {
                    'gateway.command': command,
                    url: url.toString(),
                } 
            });
            const response = await fetch(url, {
                method: "POST",    
                headers,
                body: payload ? JSON.stringify(payload) : undefined
            });
            ctx.finishSpan(span1);
            return this.parseNodeResponse<T>(undefined as any, response);
        } catch(error) {
            return {
                result: undefined,
                error: error,
            }
        }
    }

    @Method
    private async parseNodeResponse<T>(node: SidecarNode, response: Response) {

        let responseData: { result?: T, error?: any, meta?: any };

        if (!response.ok) {
            responseData = {
                error: new Errors.MoleculerServerError(response.statusText, response.status, response.statusText),
            }
            return responseData;
        }

        const contentType = response.headers.get("content-type");
        if (!contentType) {
            responseData = {
                error: new Errors.MoleculerClientError("Missing content-type", 500, "MISSING_CONTENT_TYPE_HEADER"),
            }
            return responseData;
        }

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

        if (!responseData || responseData.error) {
            if (responseData.error) {
                const { message, code, data, type, stack } = responseData.error;
                responseData.error = new Errors.MoleculerError(message, code, type, data);
                responseData.error.stack = stack;
            } else {
                responseData.error = new Errors.MoleculerError("Unexpected error", response.status, response.statusText);
            }
        }

        return responseData;
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
    protected async authorize(ctx: Context, route: Route, req: IncomingRequest, res: GatewayResponse): Promise<Context> {
        let auth = req.headers["authorization"];
        if (!auth) {
            // No token
            return Promise.reject(
                new WebErrors.UnAuthorizedError(WebErrors.ERR_NO_TOKEN, null)
            );
        }

        const partialRequest = _.pick<IncomingRequest & { rawBody: any }, 'headers' | 'method' | 'originalUrl' | 'rawBody'>(req as unknown as IncomingRequest & { rawBody: any }, ["headers", "method", "originalUrl", "rawBody"]);

        const { valid, error } = await ctx.call<VerifyRequestResponse, VerifyRequestParams>('$auth.verifyRequest', partialRequest);

        if (error) {
            return Promise.reject(
                new WebErrors.UnAuthorizedError(WebErrors.ERR_INVALID_TOKEN, error)
            );
        }

        if (valid) {
            return Promise.resolve(ctx);
        }

        return Promise.reject(
            new WebErrors.UnAuthorizedError(WebErrors.ERR_INVALID_TOKEN, undefined)
        );
    }

    @Method 
    protected reformatError(error: any) {
        return wrapResponse(error);
    }

    protected async started() {
        const servicesByNodes = await this.broker.call<{ [key: string]: ServiceSchema[] }>("$nodes.getServices");
        for (const nodeID of Object.keys(servicesByNodes)) {
            const serviceSchemas = servicesByNodes[nodeID];
            for (const schema of serviceSchemas) {
                this.actions.registerNodeService({ nodeID, schema });
            }
        }
    }

    protected async created() {
    }

}

export default SidecarService;