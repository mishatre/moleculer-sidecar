import { randomBytes } from 'node:crypto';
import kleur from 'kleur';
import { action, defineSettings, method, service, started } from 'moldecor';
import type { Context } from 'moleculer';
import DbService from 'moleculer-db';
import SequelizeDbAdapter from 'moleculer-db-adapter-sequelize';
import Sequelize from 'sequelize';
import { NotFoundError } from '../errors.js';
import { Errors, Service as MoleculerService } from '../runtime/cjs-interop.js';
import { getPgliteConnection } from '../runtime/pglite.js';
import type { IncomingMessage } from '../types.js';
import { parseReqSigV4, validateMessage } from '../utils/aws-signature.js';

const settings = defineSettings({});

export interface VerifyRequestParams {
    req: IncomingMessage & { originalUrl: string; method: string };
}

export interface GetStoredSecretKeyParams {
    accessKey: string;
}

export type VerifyRequestResponse = boolean;
export type GetStoredSecretKeyResponse = string | undefined;
export type GenerateAccessKeyResponse = {
    accessKey: string;
    secretKey: string;
};

export interface AccessKeyInfo {
    accessKey: string;
}

export interface RevokeAccessKeyParams {
    accessKey: string;
}

interface CredentialsOptions {
    accessKeyLength?: number;
    secretKeyLength?: number;
    charset?: string;
}

function generateAccessCredentials(options: CredentialsOptions = {}) {
    const {
        accessKeyLength = 20, // default length for access key
        secretKeyLength = 40, // default length for secret key
        charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    } = options;

    return {
        accessKey: generateRandomString(accessKeyLength, charset),
        secretKey: generateRandomString(secretKeyLength, charset),
    };
}

function generateRandomString(length: number, charset: string): string {
    const charsetLength = charset.length;
    const bytes = randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
        // Use modulo to pick a character index from the charset
        result += charset[bytes[i] % charsetLength];
    }
    return result;
}

@service({
    name: '$sidecar.auth',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    settings,

    mixins: [DbService],
    adapter: new SequelizeDbAdapter({
        // The database is the shared PGlite instance (src/runtime/pglite.ts); one
        // pool connection per service, budgeted by the socket's maxConnections.
        dialect: 'postgres',
        host: getPgliteConnection().host,
        port: getPgliteConnection().port,
        database: 'postgres',
        username: 'postgres',
        password: 'postgres',
        logging: false,
        pool: { max: 1 },
    }),

    model: {
        name: 'records',
        define: {
            accessKey: {
                type: Sequelize.STRING,
                primaryKey: true,
            },
            secretKey: Sequelize.STRING,
        },
        options: {
            schema: 'auth',
        },
    },

    // Disable all moleculer-db actions
    actions: {
        find: false,
        count: false,
        list: false,
        create: false,
        insert: false,
        get: false,
        update: false,
        remove: false,
    },
})
export default class SidecarAuthService extends MoleculerService<typeof settings> {
    private adapter!: SequelizeDbAdapter & { db: Sequelize.Sequelize };
    @action({
        name: 'verifyRequest',
        params: {
            req: 'object',
        },
        tracing: {
            tags: {
                params: false,
            },
        },
        visibility: 'protected',
    })
    protected async verifyRequest(
        ctx: Context<VerifyRequestParams>,
    ): Promise<VerifyRequestResponse> {
        const { req } = ctx.params;
        if (!req.method) {
            throw new Error('Method is undefined');
        }
        const { success, error, message } = parseReqSigV4(req);
        if (!success) {
            throw error;
        }

        const secretKey = await this.actions.getStoredSecretKey<Promise<string | undefined>>(
            {
                accessKey: message.accessKey,
            },
            { parentCtx: ctx },
        );

        if (!secretKey) {
            throw new Errors.MoleculerError('INVALID_ACCESS_KEY', 400);
        }
        const result = validateMessage(message, secretKey);
        if (!result.valid) {
            throw new Errors.MoleculerError(result.error!, 400);
        }
        return true;
    }

    @action({
        name: 'getStoredSecretKey',
        params: {
            accessKey: 'string',
        },
        cache: {
            keys: ['accessKey'],
            ttl: 3600,
        },
        visibility: 'private',
    })
    protected async getStoredSecretKey(
        ctx: Context<GetStoredSecretKeyParams>,
    ): Promise<GetStoredSecretKeyResponse> {
        const { accessKey } = ctx.params;

        const record = (await this.adapter.findById(accessKey)) as { secretKey: string } | null;

        return record?.secretKey;
    }

    @action({
        name: 'generateAccessKey',
        visibility: 'protected',
    })
    protected async generateAccessKey(ctx: Context): Promise<GenerateAccessKeyResponse> {
        const pair = this.generateKeyPair();
        await this.adapter.insert(pair);

        return pair;
    }

    @action({
        name: 'listAccessKeys',
        visibility: 'protected',
    })
    protected async listAccessKeys(ctx: Context): Promise<AccessKeyInfo[]> {
        const records = (await this.adapter.find({ query: {} })) as Array<{ accessKey: string }>;

        return records
            .map((record) => ({ accessKey: record.accessKey }))
            .sort((left, right) => left.accessKey.localeCompare(right.accessKey));
    }

    @action({
        name: 'revokeAccessKey',
        params: {
            accessKey: 'string',
        },
        visibility: 'protected',
    })
    protected async revokeAccessKey(ctx: Context<RevokeAccessKeyParams>): Promise<boolean> {
        const { accessKey } = ctx.params;
        if (!(await this.adapter.findById(accessKey))) {
            throw new NotFoundError('ACCESS_KEY_NOT_FOUND');
        }

        // Drop the cached secret first: a revoked key must stop verifying now.
        await this.invalidateSecretKeyCache(accessKey, ctx);
        await this.adapter.removeById(accessKey);

        return true;
    }

    @method
    private generateKeyPair() {
        return generateAccessCredentials();
    }

    @method
    private async invalidateSecretKeyCache(accessKey: string, ctx: Context) {
        const cacher = this.broker.cacher;
        if (!cacher) {
            return;
        }

        const cacheKey = cacher.getCacheKey(
            '$sidecar.auth.getStoredSecretKey',
            { accessKey },
            ctx.meta,
            ['accessKey'],
        );
        await cacher.del(cacheKey);
    }

    @started
    public async started() {
        const recordsCount = await this.adapter.count();
        if (recordsCount > 0) {
            return;
        }

        const pair = this.generateKeyPair();
        await this.adapter.insert(pair);

        this.logger.info('********************************************************');
        this.logger.info('');
        this.logger.info('Generating first pair of keys for sidecar auth.');
        this.logger.info(`${kleur.red().bold('Be carefull')} - they will not be shown again!`);
        this.logger.info('');
        this.logger.info(`Access key:`);
        this.logger.info(`  ${kleur.green().bold(pair.accessKey)}`);
        this.logger.info('');
        this.logger.info(`Secret key:`);
        this.logger.info(`  ${kleur.gray(pair.secretKey)}`);
        this.logger.info('');
        this.logger.info('********************************************************');
    }
}
