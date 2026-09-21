import path from 'node:path';
import { defineSettings, method, service, started, stopped } from 'moldecor';
import { ForbiddenError, ServiceUnavailableError } from '../errors.js';
import { Service as MoleculerService } from '../runtime/cjs-interop.js';
import { ensureDataDir } from '../runtime/paths.js';
import { getServer, type ServerRequest } from '../server.js';
import type { IncomingMessage, ServerResponse } from '../types.js';
import { isLoopback } from '../utils/utils.js';

// Loaded through a runtime specifier on purpose. A static `import '@moleculer/lab'`
// is hoisted to the top of the packaged bundle, i.e. evaluated *before* the
// packaged filesystem is patched (see src/index.ts) — and lab's ES module
// destructures `fs/promises` at load time, so it captures the archive helper that
// only accepts path strings and rejects the `file:` URLs pglite builds for
// `postgres.wasm`/`postgres.data`. Deferring the import to the moment `--lab` is
// used keeps that snapshot on the patched side.
const LAB_PACKAGE = '@moleculer/lab';
const { default: LabAgent } = (await import(LAB_PACKAGE)) as {
    default: typeof import('@moleculer/lab').default;
};

const LAB_PATH = '/lab';

/**
 * Optional external PostgreSQL for lab's store, e.g.
 * `postgres://user:pass@host:5432/db`. Leave it unset to use lab's embedded
 * PostgreSQL, which runs from the packaged binary as well.
 */
const PG_URL = process.env.LAB_PG_URL?.trim();

const settings = defineSettings({
    token: process.env.LAB_TOKEN,
    apiKey: process.env.LAB_API_KEY,
    server: { enabled: false },
    basePath: LAB_PATH,
    store: {
        connectionString: PG_URL,
        // Lab writes its config/state here; never relative to the cwd, which a
        // service manager does not set to a writable directory.
        folder: path.join(ensureDataDir(), 'lab'),
    },
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
