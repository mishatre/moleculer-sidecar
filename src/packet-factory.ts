import { BrokerNode, Context, ServiceBroker } from 'moleculer';

import { Packet, PacketType, PacketTypeKeys } from './packet.js';
import { Node } from './registry/node.js';

export class PacketFactory {
    constructor(
        private broker: ServiceBroker,
        private version: string,
    ) {}

    private createPacket(type: PacketTypeKeys, target: string | null, payload: any) {
        const sender = this.broker.nodeID;
        const ver = this.version;
        return new Packet({
            type,
            target,
            payload,
            sender,
            ver,
        });
    }

    public discover(target: string) {
        return this.createPacket(PacketType.PACKET_DISCOVER, target, {});
    }

    public discoverServices(target: string) {
        return this.createPacket(PacketType.PACKET_DISCOVER_SERVICES, target, {});
    }

    public request(ctx: Context) {
        return this.createPacket(PacketType.PACKET_REQUEST, ctx.nodeID, {
            id: ctx.id,
            action: ctx.action?.name!,
            params: ctx.params,
            meta: ctx.meta,
            timeout: ctx.options.timeout!,
            level: ctx.level,
            tracing: ctx.tracing!,
            parentID: ctx.parentID!,
            requestID: ctx.requestID!,
            caller: ctx.caller!,

            handler: ctx.locals.handler as unknown as string,
        });
    }

    public event(ctx: Context) {
        return this.createPacket(PacketType.PACKET_EVENT, ctx.endpoint ? ctx.nodeID : null, {
            id: ctx.id,
            event: ctx.eventName!,
            data: ctx.params,
            groups: ctx.eventGroups!,
            eventType: ctx.eventType!,
            meta: ctx.meta,
            level: ctx.level,
            tracing: ctx.tracing!,
            parentID: ctx.parentID!,
            requestID: ctx.requestID!,
            caller: ctx.caller!,
            needAck: ctx.needAck!,

            handler: ctx.locals.handler,
        });
    }

    public channelEvent(ctx: Context, raw: any) {
        return this.createPacket(
            PacketType.PACKET_CHANNEL_EVENT,
            ctx.endpoint ? ctx.nodeID : null,
            {
                id: ctx.id,
                data: ctx.params,
                meta: ctx.meta,
                tracing: ctx.tracing,
                requestID: ctx.requestID,
                raw: {
                    info: raw.info,
                    redelivered: raw.redelivered,
                    reply: raw.reply,
                    seq: raw.seq,
                    sid: raw.sid,
                    subject: raw.subject,
                },

                handler: ctx.locals.handler,
            },
        );
    }

    public info(nodeID: string, info: BrokerNode, sidecarNodes: Partial<Node>[]) {
        return this.createPacket(PacketType.PACKET_INFO, nodeID, {
            services: info.services,
            ipList: info.ipList,
            hostname: info.hostname,
            client: info.client,
            config: info.config,
            instanceID: this.broker.instanceID,
            metadata: info.metadata,
            seq: info.seq,
            sidecarNodes,
        });
    }

    public requestHeartbeat(nodeID: string) {
        return this.createPacket(PacketType.PACKET_REQUEST_HEARTBEAT, nodeID, {});
    }

    public response(target: string, id: string, error: any, data: any, meta?: any) {
        return this.createPacket(PacketType.PACKET_RESPONSE, target, {
            id,
            meta,
            success: error == null,
            error: error ? this.broker.errorRegenerator?.extractPlainError(error) : undefined,
            data,
        });
    }
}
