import { Errors, GenericObject, ServiceSchema } from 'moleculer';

import { NodeGateway } from './gateway.js';
import { Node } from './registry/node.js';

export enum PacketType {
    PACKET_UNKNOWN = 'PACKET_UNKNOWN',

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
};

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
    type: PacketTypeKeys;
    target: string | null;
    sender: string;
    ver: string;
    payload: PayloadByPacketType[PacketTypeKeys];
};

export const PROTOCOL_VERSION = '1';

export class Packet<P extends PacketTypeKeys = PacketType.PACKET_UNKNOWN> {
    public readonly type: P;
    public readonly target: string | null;
    public readonly sender: string;
    public readonly ver: string;
    public readonly payload: PayloadByPacketType[P];

    #rawPacket: RawPacket;

    constructor(rawPacket: RawPacket) {
        if (!rawPacket.type) {
            rawPacket.type = PacketType.PACKET_UNKNOWN;
        }
        this.type = <P>rawPacket.type;
        this.target = rawPacket.target;
        this.sender = rawPacket.sender;
        this.ver = rawPacket.ver;
        this.payload = rawPacket.payload;
        this.#rawPacket = rawPacket;
    }

    public static fromRaw<P extends PacketTypeKeys>(rawPacket: RawPacket) {
        let type: P;
        if (rawPacket.type in PacketType) {
            type = <P>PacketType[rawPacket.type as keyof typeof PacketType];
        } else {
            type = <P>PacketType.PACKET_UNKNOWN;
        }

        // Check payload
        if (!rawPacket.payload) {
            throw new Errors.MoleculerServerError(
                'Missing response payload.',
                500,
                'MISSING_PAYLOAD',
            );
        }

        // Check protocol version
        if (rawPacket.ver !== PROTOCOL_VERSION) {
            throw new Errors.ProtocolVersionMismatchError({
                nodeID: rawPacket.sender,
                actual: PROTOCOL_VERSION,
                received: rawPacket.ver,
            });
        }

        return new Packet(rawPacket);
    }

    public static deserialize(value: string, deserializer?: any) {
        if (!deserializer) {
            deserializer = JSON.parse;
        }
        return this.fromRaw(deserializer(value));
    }

    public serialize(serializator?: any) {
        if (!serializator) {
            serializator = JSON.stringify;
        }
        return serializator(this.#rawPacket);
    }
}
