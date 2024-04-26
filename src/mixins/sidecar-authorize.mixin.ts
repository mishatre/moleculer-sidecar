import { Level } from 'level';
import _ from 'lodash';
import { Action, Created, Method, Service, Started, Stopped } from 'moldecor';
import { Context, Errors, Service as MoleculerService, ServiceSettingSchema } from 'moleculer';
import ApiGateway from 'moleculer-web';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { parseReqSigV4, validateMessage } from '../uitls/aws-signature.js';
import { getRootDir } from '../uitls/index.js';
import { IncomingMessage } from './sidecar-gateway.mixin.js';

interface SidecarAuthorizeSettings extends ServiceSettingSchema {}

const WebErrors = ApiGateway.Errors;

@Service({
    name: 'sidecarAuthorize',
    settings: {},
})
export default class SidecarAuthorize extends MoleculerService<SidecarAuthorizeSettings> {
    private auth_dbPath!: string;
    private auth_db!: Level<string, string>;

    @Action({
        name: 'verifyRequest',
        params: {
            req: 'object',
        },
        tracing: {
            tags: {
                params: false,
            },
        },
        visibility: 'private',
    })
    protected async verifyRequest(
        ctx: Context<{ req: IncomingMessage & { originalUrl: string } }>,
    ) {
        const { req } = ctx.params;
        const { success, error, message } = parseReqSigV4(req);
        if (!success) {
            throw error;
        }

        return this.actions
            .getStoredSecretKey<Promise<string>>(
                {
                    accessKey: message.accessKey,
                },
                { parentCtx: ctx },
            )
            .then((secretKey) => {
                if (!secretKey) {
                    throw new Errors.MoleculerError('INVALID_ACCESS_KEY', 400);
                }
                const result = validateMessage(message, secretKey);
                if (!result.valid) {
                    throw new Errors.MoleculerError(result.error!, 400);
                }
                return true;
            });
    }

    @Action({
        name: 'storeKey',
        params: {
            accessKey: 'string',
            secretKey: 'string',
        },
        visibility: 'private',
    })
    protected storeKey(ctx: Context<{ accessKey: string; secretKey: string }, any>) {
        const { accessKey, secretKey } = ctx.params;

        return this.actions
            .getStoredSecretKey({ accessKey })
            .then(async (savedSecretKey) => {
                if (savedSecretKey && savedSecretKey !== secretKey) {
                    throw new Errors.MoleculerError('INVALID_ACCESS_KEY', 400);
                }
                await this.auth_db.put(accessKey, secretKey);
                return true;
            })
            .catch((error) => {
                ctx.broker.logger.error(error);
                return false;
            });
    }

    @Action({
        name: 'deleteKeyPair',
        params: {
            accessKey: 'string',
        },
        visibility: 'private',
    })
    protected deleteKey(ctx: Context<{ accessKey: string }, any>) {
        const { accessKey } = ctx.params;
        return this.auth_db
            .del(accessKey)
            .then(async () => {
                await this.broker.cacher?.del(`$auth.getStoredSecretKey:${accessKey}`);
                return true;
            })
            .catch((error) => {
                ctx.broker.logger.error(error);
                return false;
            });
    }

    @Action({
        name: 'generateKeyPair',
        visibility: 'private',
    })
    protected async generateKeyPair(ctx: Context<any, any>) {
        return {
            accessKey: randomBytes(16).toString('base64url'),
            secretKey: randomBytes(32).toString('base64url'),
        };
    }

    @Action({
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
    protected getStoredSecretKey(ctx: Context<{ accessKey: string }>) {
        const { accessKey } = ctx.params;
        return this.auth_db.get(accessKey).catch((error) => {
            if (error.code === 'LEVEL_NOT_FOUND') {
                return undefined;
            } else {
                ctx.broker.logger.error(error);
            }
        });
    }

    // Sidecar gateway authorize method

    @Method
    protected async authorize(ctx: Context, req: IncomingMessage): Promise<Context> {
        let auth = req.headers['authorization'];
        if (!auth) {
            // No token
            return Promise.reject(new WebErrors.UnAuthorizedError(WebErrors.ERR_NO_TOKEN, null));
        }

        return this.actions
            .verifyRequest({ req }, { parentCtx: ctx })
            .then((valid) => {
                if (!valid) {
                    return Promise.reject(
                        new WebErrors.UnAuthorizedError(WebErrors.ERR_INVALID_TOKEN, undefined),
                    );
                }
                return Promise.resolve(ctx);
            })
            .catch((error) => {
                return Promise.reject(
                    new WebErrors.UnAuthorizedError(WebErrors.ERR_INVALID_TOKEN, error),
                );
            });
    }

    /**
     * Service created lifecycle event handler
     */
    @Created
    public created() {
        this.auth_dbPath = path.join(process.env.DATA ?? path.join(getRootDir(), 'data'), 'auth');
        mkdirSync(this.auth_dbPath, { recursive: true });
    }

    /**
     * Service started lifecycle event handler
     */
    @Started
    public started() {
        // Create a database
        this.auth_db = new Level(this.auth_dbPath, { valueEncoding: 'json' });
        this.auth_db.open(() => {
            this.logger.info('Auth database connected');
            this.auth_db.get('INITIALIZED').catch(async (error) => {
                if (error.code === 'LEVEL_NOT_FOUND') {
                    this.logger.info('Initializing auth database');

                    const { accessKey, secretKey } = await this.actions.generateKeyPair({});
                    await this.actions.storeKey({ accessKey, secretKey });
                    await this.auth_db.put('INITIALIZED', '');
                    this.logger.warn(
                        `Created default:
accessKey: '${accessKey}' 
secretKey: '${secretKey}' 
They will be shown only once.`,
                    );
                }
            });
        });
    }

    /**
     * Service stopped lifecycle event handler
     */
    @Stopped
    protected stopped() {
        return this.auth_db.close();
    }
}
