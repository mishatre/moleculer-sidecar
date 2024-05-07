import { join } from 'node:path/posix';

export type NodeGateway = {
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

export class Gateway {
    private BASIC_PATH = '/v1/message';

    private port?: number;
    private useSSL: boolean;
    private endpoint: string;
    private path?: string;

    private auth?:
        | {
              accessToken?: string;
          }
        | { username: string; password: string };

    constructor(gateway: NodeGateway) {
        this.port = gateway.port > 0 ? gateway.port : undefined;
        this.useSSL = gateway.useSSL || false;
        this.endpoint = gateway.endpoint;
        this.path = gateway.path || '';
        this.auth = gateway.auth;
    }

    public url() {
        const port = this.port && this.port > 0 ? `:${this.port}` : '';

        const base = new URL(`${this.useSSL ? 'https' : 'http'}://${this.endpoint}${port}`);

        return new URL(join(this.path ?? '', this.BASIC_PATH), base);
    }

    public authHeaders(): Headers {
        const headers = new Headers();

        if (this.auth) {
            if ('accessToken' in this.auth) {
                headers.set('authorization', 'Bearer ' + this.auth.accessToken);
            } else if ('username' in this.auth && 'password' in this.auth) {
                headers.set(
                    'authorization',
                    'Basic ' +
                        Buffer.from(this.auth.username + ':' + this.auth.password).toString(
                            'base64',
                        ),
                );
            }
        }

        return headers;
    }
}
