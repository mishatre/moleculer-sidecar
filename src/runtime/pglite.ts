import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { ensureDataDir } from './paths.js';

/**
 * Fixed port used for the Unix domain socket file name (`.s.PGSQL.<port>`). It
 * is a file-name convention on the socket path, not a TCP listener.
 */
const SOCKET_PORT = 5432;

/**
 * The socket's connection budget. One shared PGlite instance serves two
 * Sequelize pools (one per DbService), each capped at `pool: { max: 1 }`, so
 * the server must accept at least their sum — 2. Four leaves headroom.
 */
const MAX_CONNECTIONS = 4;

export interface PgliteConnection {
    host: string;
    port: number;
}

let db: PGlite | undefined;
let server: PGLiteSocketServer | undefined;
let connection: PgliteConnection | undefined;

/** Directory holding the PGlite database and its socket; created `0700`. */
export function pgliteDataDir(): string {
    return path.join(ensureDataDir(), 'pglite');
}

function socketFile(): string {
    return path.join(pgliteDataDir(), `.s.PGSQL.${SOCKET_PORT}`);
}

/** Connection details for the Sequelize postgres dialect. */
export function getPgliteConnection(): PgliteConnection {
    if (!connection) {
        throw new Error('pglite is not started yet');
    }
    return connection;
}

/** True when a PostgreSQL peer answers at `file` — tells a live socket from a stale one. */
function hasLivePeer(file: string): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = createConnection({ path: file });
        const settle = (alive: boolean) => {
            probe.destroy();
            resolve(alive);
        };
        const timer = setTimeout(() => settle(false), 500);
        probe.once('connect', () => {
            clearTimeout(timer);
            settle(true);
        });
        probe.once('error', () => {
            clearTimeout(timer);
            settle(false);
        });
    });
}

export async function startPglite(): Promise<void> {
    if (connection) {
        return;
    }

    // Loaded lazily on purpose: @electric-sql/pglite reads its wasm/data files
    // by URL at runtime, so in a packaged binary it must be evaluated only after
    // installUrlAwareFs() has patched fs (see src/index.ts). A static import here
    // would be hoisted above that patch by the bundler.
    const [{ PGlite }, { PGLiteSocketServer }] = await Promise.all([
        import('@electric-sql/pglite'),
        import('@electric-sql/pglite-socket'),
    ]);

    const dataDir = pgliteDataDir();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        chmodSync(dataDir, 0o700);
    }

    const instance = await PGlite.create(dataDir);
    await instance.exec('CREATE SCHEMA IF NOT EXISTS auth');
    await instance.exec('CREATE SCHEMA IF NOT EXISTS publication');

    if (process.platform === 'win32') {
        // No socket-directory permissions to lean on; use ephemeral loopback.
        const socket = new PGLiteSocketServer({
            db: instance,
            host: '127.0.0.1',
            port: 0,
            maxConnections: MAX_CONNECTIONS,
        });
        await socket.start();
        const [host, portText] = socket.getServerConn().split(':');
        db = instance;
        server = socket;
        connection = { host, port: Number(portText) };
        return;
    }

    // A fixed socket path inside the 0700 data dir is the single-instance mutex:
    // a second process fails to bind it (PGlite itself does not lock its data
    // directory). Note the bind is necessarily acquired after the db has opened
    // (pglite-socket requires the db to construct the server), so a second
    // process briefly opens the dir before the bind refuses it.
    const makeSocket = () =>
        new PGLiteSocketServer({
            db: instance,
            path: socketFile(),
            maxConnections: MAX_CONNECTIONS,
        });

    let socket = makeSocket();
    try {
        await socket.start();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' || !existsSync(socketFile())) {
            await instance.close();
            throw error;
        }
        // A crash can leave a stale socket file. Unlink it only when no peer is
        // listening — an unconditional unlink would let a second instance
        // displace a live one and defeat the mutex.
        if (await hasLivePeer(socketFile())) {
            await instance.close();
            throw error;
        }
        // A failed listen leaves the server handle set and it cannot be re-used,
        // so the retry needs a fresh server.
        rmSync(socketFile(), { force: true });
        socket = makeSocket();
        try {
            await socket.start();
        } catch (retryError) {
            await instance.close();
            throw retryError;
        }
    }

    db = instance;
    server = socket;
    connection = { host: dataDir, port: SOCKET_PORT };
}

export async function stopPglite(): Promise<void> {
    const socket = server;
    server = undefined;
    try {
        if (socket) {
            await socket.stop();
            if (process.platform !== 'win32') {
                rmSync(socketFile(), { force: true });
            }
        }
    } finally {
        try {
            if (db) {
                await db.close();
            }
        } finally {
            db = undefined;
            connection = undefined;
        }
    }
}
