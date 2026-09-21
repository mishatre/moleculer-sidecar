import type http from 'node:http';

import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { ActionSchema, Context, Endpoint } from 'moleculer';

type IncomingRequestExt = {
    $startTime?: [number, number];
    $ctx?: Context<any>;
    baseUrl?: string;
    originalUrl?: string;
    parsedUrl?: string;
    body?: any;
    query?: Record<string, string | string[] | number | number[] | boolean | boolean[]>;
    $endpoint: Endpoint;
    $action: ActionSchema;
    $params: Record<string, unknown>;
};

type ServerResponseExt = {
    $ctx?: Context<any>;
    locals?: any;
};

export type IncomingMessage = (Http2ServerRequest | http.IncomingMessage) & IncomingRequestExt;
export type ServerResponse = (Http2ServerResponse | http.ServerResponse) & ServerResponseExt;

export interface ConnectionInfo {
    id: string;
    endpoint: string;
    port: string;
    useSSL: boolean;
    path: string;
}

export interface AuthInfo {
    auth:
        | { token: string }
        | {
              username: string;
              password: string;
          }
        | undefined;
}
