import _ from 'lodash';
import { ServiceSchema } from 'moleculer';

import { InfoPayload } from '../packet';

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
    instanceID: string | null;
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
    public metadata: any;
    public client: ClientInfo | Object;
    public offlineSince: number | null;
    public gateway: Gateway | null;

    public rawInfo: InfoPayload | null;

    public seq: number;

    constructor(nodeID: string) {
        this.id = nodeID;
        this.instanceID = null;
        this.available = true;
        this.local = true;
        this.lastHeartbeatTime = Math.round(process.uptime());
        this.client = {};
        this.metadata = null;

        this.gateway = null;

        this.rawInfo = null;

        this.seq = 0;
        this.offlineSince = null;
    }

    public update(payload: InfoPayload, isReconnected: boolean) {
        // Update properties
        this.metadata = payload.metadata;
        this.client = payload.client || {};

        this.gateway = payload.gateway || null;

        this.rawInfo = payload;

        const newSeq = payload.seq || 1;
        if (newSeq > this.seq || isReconnected || payload.instanceID !== this.instanceID) {
            this.instanceID = payload.instanceID;
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

    public disconnected(isUnexpected: boolean) {
        if (this.available) {
            this.offlineSince = Math.round(process.uptime());
            this.seq++;
        }

        this.available = false;
    }
}
