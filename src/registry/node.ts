import _ from 'lodash';
import { ServiceSchema } from 'moleculer';

type ClientInfo = {
    type: string;
    version: string;
    moduleType: string;
    langVersion: string;
    langCompatibilityVersion: string;
};

type Gateway = {
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

export type NodeInfo = {
    instanceID: string;
    metadata: string;
    gateway?: Gateway;
    client: ClientInfo;
    config?: any;
    services?: ServiceSchema[];
    seq?: number;
};

export class Node {
    public id: string;
    public instanceID: string | null;
    public available: boolean;
    public local: boolean;
    public lastHeartbeatTime: number;
    public config: any;
    public metadata: any;
    public client: ClientInfo | Object;
    public offlineSince: number | null;
    public gateway: Gateway | null;

    public rawInfo: NodeInfo | null;

    public services: ServiceSchema[] = [];

    public seq: number;

    constructor(nodeID: string) {
        this.id = nodeID;
        this.instanceID = null;
        this.available = true;
        this.local = true;
        this.lastHeartbeatTime = Math.round(process.uptime());
        this.config = {};
        this.client = {};
        this.metadata = null;

        this.gateway = null;

        this.rawInfo = null;
        this.services = [];

        this.seq = 0;
        this.offlineSince = null;
    }

    public update(nodeInfo: NodeInfo, isReconnected: boolean) {
        // Update properties
        this.metadata = nodeInfo.metadata;
        this.client = nodeInfo.client || {};
        this.config = nodeInfo.config || {};

        this.gateway = nodeInfo.gateway || null;

        // Process services & events (should make a clone because it will manipulate the objects (add handlers))
        if (nodeInfo.services) {
            this.services = _.cloneDeep(nodeInfo.services);
        }
        this.rawInfo = nodeInfo;

        const newSeq = nodeInfo.seq || 1;
        if (newSeq > this.seq || isReconnected || nodeInfo.instanceID !== this.instanceID) {
            this.instanceID = nodeInfo.instanceID;
            this.seq = newSeq;
            return true;
        }

        return false;
    }

    public heartbeat() {
        if (!this.available) {
            this.available = true;
            this.offlineSince = null;
        }

        this.lastHeartbeatTime = Math.round(process.uptime());
    }

    public disconnected() {
        if (this.available) {
            this.offlineSince = Math.round(process.uptime());
            this.seq++;
        }

        this.available = false;
    }
}
