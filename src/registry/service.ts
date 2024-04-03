import { ActionSchema, EventSchema, ServiceSchema, ServiceSettingSchema } from 'moleculer';

import { Node } from './node';

export class ServiceItem {
    public node: Node;
    public name: string;
    public fullName: string;
    public version: string | number | undefined;
    public settings: ServiceSettingSchema | undefined;
    public metadata: Record<string, any>;
    public actions: Record<string, ActionSchema & { name: string }>;
    public events: Record<string, EventSchema & { name: string }>;

    constructor(node: Node, service: ServiceSchema) {
        this.node = node;
        this.name = service.name;
        this.fullName = service.fullName;
        this.version = service.version;
        this.settings = service.settings;
        this.metadata = service.metadata || {};

        this.actions = {};
        this.events = {};
    }

    /**
     * Update service properties
     *
     */
    update(svc: ServiceSchema) {
        this.fullName = svc.fullName;
        this.version = svc.version;
        this.settings = svc.settings;
        this.metadata = svc.metadata || {};
    }

    /**
     * Add action to service
     *
     */
    addAction(action: ActionSchema & { name: string }) {
        this.actions[action.name] = action;
    }

    /**
     * Add event to service
     *
     */
    addEvent(event: EventSchema & { name: string }) {
        this.events[event.name] = event;
    }
}
