
import { Context, Service as MoleculerService, ServiceSchema } from 'moleculer';
import { Service, Method, Action } from 'moleculer-decorators';
import { Level } from 'level';
import { AbstractSublevel } from 'abstract-level';
import { getRootDir } from '../uitls/index.js';
import path from 'path';
import { mkdirSync } from 'fs';
import { SidecarNode } from './sidecar.service.js';

@Service({
    name: "$nodes",

    settings: {
    }
})
export default class NodesService extends MoleculerService {

    private db!: Level<string, SidecarNode>;
    private nodeIds!: AbstractSublevel<Level<string, SidecarNode>, string | Buffer | Uint8Array, string, string>;
    private namespaces!: AbstractSublevel<Level<string, SidecarNode>, string | Buffer | Uint8Array, string, string>;
    private services!: AbstractSublevel<Level<string, SidecarNode>, string | Buffer | Uint8Array, string, ServiceSchema[]>;

    @Action({
        name: 'hasNode',
        params: {
            nodeID: "string"
        }
    })
    public async hasNode(ctx: Context<{ nodeID: string }>) {
        try {
            await this.nodeIds.get(ctx.params.nodeID);
        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return false;
            } else {
                throw error;
            }
        }
        return true;
    }

    @Action({
        name: 'hasNamespace',
        params: {
            namespace: "string"
        }
    })
    public async hasNamespace(ctx: Context<{ namespace: string }>) {
        try {
            await this.namespaces.get(ctx.params.namespace);
        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return false;
            } else {
                throw error;
            }
        }
        return true;
    }

    @Action({
        name: 'getNode',
        params: {
            nodeID: "string"
        }
    })
    public async getNode(ctx: Context<{ nodeID: string }>) {
        const { nodeID } = ctx.params;
        return await this.getSavedNode(nodeID);
    }

    @Action({
        name: 'addNode',
        params: {
            node: "any"
        }
    })
    public async addNode(ctx: Context<{ node: SidecarNode }>) {
        const node = ctx.params.node;
        try {
            const items = [{
                type: 'put',
                key: node.nodeID,
                value: node,
            },
            {
                type: 'put',
                sublevel: this.nodeIds,
                key: node.nodeID,
                value: '' as any,
            }];
            if (node.servicePublication?.namespace) {
                items.push({
                    type: 'put',
                    sublevel: this.namespaces,
                    key: node.servicePublication.namespace,
                    value: '' as any,
                });
            }

            await this.db.batch(items as any);

        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return false;
            } else {
                throw error;
            }
        }
        return true;
    }

    @Action({
        name: 'removeNode',
        params: {
            nodeID: "string"
        }
    })
    public async removeNode(ctx: Context<{ nodeID: string }>) {
        const { nodeID } = ctx.params;

        const node = await this.getSavedNode(nodeID);
        const nodeSerivces = await this.getServicesByNodeID(nodeID);

        if (nodeSerivces) {
            try {
                await this.services.del(nodeID);
            } catch(error: any) {
                if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                } else {
                    throw error;
                }
            }
        }

        if (!node) {

            try {
                await this.nodeIds.del(nodeID);
            } catch(error: any) {
                if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                } else {
                    throw error;
                }
            }

            return true;
        }

        try {

            const items = [{
                type: 'del',
                key: node.nodeID,
            },
            {
                type: 'del',
                sublevel: this.nodeIds,
                key: node.nodeID,
            }];
            if (node.servicePublication?.namespace) {
                items.push({
                    type: 'del',
                    sublevel: this.namespaces,
                    key: node.servicePublication.namespace,
                });
            }
            await this.db.batch(items as any);
        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return false;
            } else {
                throw error;
            }
        }
        return true;
    }

    @Action({
        name: 'addService',
        params: {
            nodeID: "string",
            service: "object"
        }
    })
    public async addService(ctx: Context<{ nodeID: string, service: ServiceSchema }>) {
        const { nodeID, service } = ctx.params;
        const nodeServices = await this.getServicesByNodeID(nodeID) || [];
        if (nodeServices?.find(n => n.name === service.name && n.version === service.version)) {
            return false;
        }
        nodeServices?.push(service);
        try {
            await this.services.put(nodeID, nodeServices);
        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return false;
            } else {
                throw error;
            }
        }
        return true;
    }

    @Action({
        name: 'removeService',
        params: {
            nodeID: "string",
            serviceName: "string",
            version: ["string|optional", "number|optional"]
        }
    })
    public async removeService(ctx: Context<{ nodeID: string, serviceName: string, version?: string | number }>) {
        const { nodeID, serviceName, version } = ctx.params;
        const nodeServices = await this.getServicesByNodeID(nodeID) || [];
        console.log(nodeServices, serviceName, version);
        if (!nodeServices?.find(n => n.name === serviceName && (!version || n.version == version))) {
            return true;
        }
        nodeServices?.splice(nodeServices?.findIndex(n => n.name === serviceName && (!version || n.version === version)), 1);
        try {
            await this.services.put(nodeID, nodeServices);
        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return false;
            } else {
                throw error;
            }
        }
        return true;
    }

    @Action({
        name: "getServices",
        params: {}
    })
    public async getServices(ctx: Context) {
        const services = {} as { [key: string]: ServiceSchema[] };
        for await (const key of this.services.keys()) {
            const serviceSchema = await this.services.get(key);
            services[key] = serviceSchema;
        }
        return services;
    }

    @Action({
        name: "getNodeServices",
        params: {
            nodeID: "string"
        }
    })
    public async getNodeServices(ctx: Context<{ nodeID: string }>) {
        const { nodeID } = ctx.params;
        return await this.getServicesByNodeID(nodeID);
    }

    @Method
    private async getSavedNode(nodeID: string) {
        try {
            return await this.db.get(nodeID);
        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return undefined;
            } else {
                throw error;
            }
        }
    }

    @Method
    private async getServicesByNodeID(nodeID: string) {
        try {
            return await this.services.get(nodeID);
        } catch(error: any) {
            if ('code' in error && error.code === 'LEVEL_NOT_FOUND') {
                return [];
            } else {
                throw error;
            }
        }
    }

    protected started() {

        const dbPath = path.join(process.env.DATA ?? path.join(getRootDir(), 'data'), 'nodes');
        mkdirSync(dbPath, { recursive: true });

        // Create a database
        this.db = new Level<string, SidecarNode>(dbPath, { valueEncoding: 'json' });

        this.nodeIds = this.db.sublevel('nodes');
        this.namespaces = this.db.sublevel('namespaces');
        this.services = this.db.sublevel<string, ServiceSchema[]>('services', { valueEncoding: 'json' });

        // this.db.clear();
        // this.namespaces.clear();
        // this.services.clear();

    }

}