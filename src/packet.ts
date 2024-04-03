import { Errors } from 'moleculer';

export enum PacketType {
    PACKET_UNKNOWN = 'PACKET_UNKNOWN',
    PACKET_ERROR = 'PACKET_ERROR',
    PACKET_REQUEST = 'PACKET_REQUEST',
    PACKET_RESPONSE = 'PACKET_RESPONSE',
    PACKET_EVENT = 'PACKET_EVENT',
    PACKET_DISCOVER = 'PACKET_DISCOVER',
    PACKET_INFO = 'PACKET_INFO',
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
};

type PayloadByPacketType = {
    [PacketType.PACKET_UNKNOWN]: { shiiiiit: any };
    [PacketType.PACKET_REQUEST]: RequestPayload;
    [PacketType.PACKET_RESPONSE]: never;
    [PacketType.PACKET_EVENT]: never;
    [PacketType.PACKET_DISCOVER]: never;
};

export type RawPacket = {
    type: string;
    target: string | null;
    payload?: any;
};

export type PacketPayload<P extends PacketType> = PayloadByPacketType[P] & {
    sender: string;
    ver: string;
};

export const PROTOCOL_VERSION = '1';

export class Packet<P extends PacketType> {
    constructor(
        public type: P,
        public target: string | null = null,
        public payload: PayloadByPacketType[P] & { sender: string; ver: string } = {},
    ) {
        if (!this.type) {
            this.type = PacketType.PACKET_UNKNOWN as P;
        }
    }

    public static fromRaw<P extends PacketType, T = PayloadByPacketType[P]>(value: RawPacket) {
        let type: P;
        if (value.type in PacketType) {
            type = PacketType[value.type as keyof typeof PacketType] as P;
        } else {
            type = PacketType.PACKET_UNKNOWN as P;
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

        return new Packet<P>(type, value.target, value.payload as T);
    }

    public static deserialize(value: string, deserializer?: any) {
        return this.fromRaw(deserializer?.(value) ?? JSON.parse(value));
    }

    public serialize(serializator?: any) {
        return serializator?.(this) ?? JSON.stringify(this);
    }

    public extend(sender: string, ver: string) {
        this.payload.sender = sender;
        this.payload.ver = ver;
    }
}
