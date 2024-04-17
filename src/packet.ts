import { Errors, GenericObject, ServiceSchema } from 'moleculer';

import { NodeGateway } from './gateway';
import { Node } from './registry/node';

export enum PacketType {
    PACKET_UNKNOWN = 'PACKET_UNKNOWN',
    PACKET_ERROR = 'PACKET_ERROR',

    PACKET_REQUEST = 'PACKET_REQUEST',
    PACKET_RESPONSE = 'PACKET_RESPONSE',
    PACKET_EVENT = 'PACKET_EVENT',
    PACKET_DISCOVER = 'PACKET_DISCOVER',
    PACKET_DISCOVER_SERVICES = 'PACKET_DISCOVER_SERVICES',
    PACKET_INFO = 'PACKET_INFO',
    PACKET_SERVICES_INFO = 'PACKET_SERVICES_INFO',

    PACKET_HEARTBEAT = 'PACKET_HEARTBEAT',
    PACKET_REQUEST_HEARTBEAT = 'PACKET_REQUEST_HEARTBEAT',
    PACKET_DISCONNECT = 'PACKET_DISCONNECT',

    PACKET_PING = 'PACKET_PING',
    PACKET_PONG = 'PACKET_PONG',

    PACKET_CHANNEL_EVENT = 'PACKET_CHANNEL_EVENT',
    PACKET_CHANNEL_EVENT_REQUEST = 'PACKET_CHANNEL_EVENT_REQUEST',
}

type AdditionalInfo = {
    sender: string;
    ver: string;
};

export type RequestPayload = {
    id: string;
    action: string;
    params: any;
    meta: any;
    timeout: number;
    level: number;
    tracing: boolean;
    parentID: string;
    requestID: string;
    caller: string;

    handler: string;
};

export type ResponsePayload = {
    id: string;
    meta: any;
    success: boolean;
    data: any;
    error: any;
};

export type EventPayload = {
    id: string;
    event: string;
    data: any;
    groups: string[];
    eventType: string;
    meta: any;
    level: number;
    tracing: boolean;
    parentID: string;
    requestID: string;
    caller: string;
    needAck: boolean;

    handler: string;
};

export type NodeInfoPayload = {
    services: GenericObject[];
    ipList: string[];
    hostname: string | null;
    client: any;
    config: any;
    instanceID: string;
    metadata: any;
    seq: number;
    sidecarNodes: Exclude<Node, 'rawInfo'>[];
};

export type InfoPayload = {
    instanceID: string;
    metadata: any;
    gateway: NodeGateway;
    client: {
        type: string;
        version: string;
        moduleType: string;
        landVersion: string;
        langCompatibilityVersion: string;
    };
    seq: number;
    sidecar?: ServiceSchema[];
} & AdditionalInfo;

export type PingPayload = {
    time: number;
    id: string;
};

export type PongPayload = {
    time: number;
    id: string;
    arrived: number;
};

export interface PayloadByPacketType {
    [PacketType.PACKET_UNKNOWN]: never;
    [PacketType.PACKET_ERROR]: never;

    [PacketType.PACKET_REQUEST]: RequestPayload;
    [PacketType.PACKET_RESPONSE]: ResponsePayload;
    [PacketType.PACKET_EVENT]: EventPayload;
    [PacketType.PACKET_DISCOVER]: {};
    [PacketType.PACKET_DISCOVER_SERVICES]: {};
    [PacketType.PACKET_INFO]: NodeInfoPayload;
    [PacketType.PACKET_SERVICES_INFO]: {
        services: ServiceSchema[];
    };

    [PacketType.PACKET_HEARTBEAT]: {};
    [PacketType.PACKET_REQUEST_HEARTBEAT]: {};
    [PacketType.PACKET_DISCONNECT]: never;

    [PacketType.PACKET_PING]: PingPayload;
    [PacketType.PACKET_PONG]: PongPayload;

    [PacketType.PACKET_CHANNEL_EVENT]: any;
    [PacketType.PACKET_CHANNEL_EVENT_REQUEST]: any;
}

export type PacketTypeKeys = keyof PayloadByPacketType;

export type RawPacket = {
    type: string;
    target: string | null;
    payload?: any;
};

export const PROTOCOL_VERSION = '1';

export class Packet<P extends PacketTypeKeys> {
    constructor(
        public type: P,
        public target: string | null = null,
        public payload: PayloadByPacketType[P] & { sender?: string; ver?: string },
    ) {
        if (!this.type) {
            this.type = PacketType.PACKET_UNKNOWN as P;
        }
    }

    public static fromRaw<P extends PacketTypeKeys>(value: RawPacket) {
        let type: P;
        if (value.type in PacketType) {
            type = <P>PacketType[value.type as keyof typeof PacketType];
        } else {
            type = <P>PacketType.PACKET_UNKNOWN;
        }

        // Check payload
        if (!value.payload) {
            throw new Errors.MoleculerServerError(
                'Missing response payload.',
                500,
                'MISSING_PAYLOAD',
            );
        }

        // Check protocol version
        if (value.payload.ver !== PROTOCOL_VERSION) {
            throw new Errors.ProtocolVersionMismatchError({
                nodeID: value.payload.sender,
                actual: PROTOCOL_VERSION,
                received: value.payload.ver,
            });
        }

        return new Packet(type, value.target, value.payload);
    }

    public static deserialize(value: string, deserializer?: any) {
        return this.fromRaw(deserializer?.(value) ?? JSON.parse(value));
    }

    public serialize(serializator?: any) {
        return (
            serializator?.(this) ??
            JSON.stringify({
                type: this.type,
                target: this.target,
                payload: this.payload,
            })
        );
    }

    public extend(sender: string, ver: string) {
        this.payload.sender = sender;
        this.payload.ver = ver;
    }
}
