import LabAgent from '@moleculer/lab';
import { defineSettings, method, service, started, stopped } from 'moldecor';
import { Service as MoleculerService } from 'moleculer';
import { ForbiddenError, ServiceUnavailableError } from '../errors.js';
import { getServer, type ServerRequest } from '../server.js';
import type { IncomingMessage, ServerResponse } from '../types.js';
import { isLoopback } from '../utils/utils.js';

const LAB_PATH = '/lab';

const settings = defineSettings({
    token: process.env.LAB_TOKEN,
    apiKey: process.env.LAB_API_KEY,
    server: { enabled: false },
    basePath: LAB_PATH,
});

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

@service({
    name: 'lab',
    mixins: [LabAgent.AgentService],
    settings,
})
export default class LabAgentService extends MoleculerService<typeof settings> {
    declare private getRequestListener: () => RequestListener | undefined;

    private unmount?: () => void;

    @method
    private handleRequest({ req, res }: ServerRequest) {
        if (!isLoopback(req.socket.remoteAddress)) {
            throw new ForbiddenError('LAB_LOCAL_ONLY');
        }

        const listener = this.getRequestListener();
        if (!listener) {
            throw new ServiceUnavailableError('LAB_NOT_READY');
        }

        return listener(req, res);
    }

    @started
    public started() {
        const path = this.settings.basePath ?? LAB_PATH;
        this.unmount = getServer().mount(path, (request) => this.handleRequest(request), {
            slashRedirect: true,
        });
    }

    @stopped
    public stopped() {
        this.unmount?.();
        this.unmount = undefined;
    }
}
