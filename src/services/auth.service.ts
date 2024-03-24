
import { Context, Service as MoleculerService, Errors } from 'moleculer';
import { Service, Method, Action } from 'moleculer-decorators';
import { parseReqSigV4, validateMessage } from '../uitls/aws-signature.js';
import { IncomingHttpHeaders } from 'http';
import { Level } from 'level';
import { getRootDir } from '../uitls/index.js';
import path from 'path';
import { mkdirSync } from 'fs';
import { randomBytes } from 'crypto';

export type VerifyRequestParams = {
    headers: IncomingHttpHeaders,
    originalUrl: string,
    method?: string, 
    rawBody: any
}
export type VerifyRequestResponse = {
    valid: boolean,
    error?: string
}


@Service({
    name: "$auth", 

    settings: {
    }
})
export default class AuthService extends MoleculerService {

    private db!: Level;

    @Action({
        name: "verifyRequest",
        params: {
            headers: "any",
            originalUrl: "string",
            method: "string",
            rawBody: "any|optional",
        }
    })
    public async verifyRequest(ctx: Context<{ 
        headers: IncomingHttpHeaders;
        originalUrl: string;
        method: string;
        rawBody: any;
    }, any>) {

        const { success, error, message } = parseReqSigV4(ctx.params);
        if (!success) {
            return {
                valid: false,
                error,
            }
        }

        const secretKey = await ctx.call<string | undefined, { accessKey: string }>(
            "$auth.getStoredSecretKey", 
            { 
                accessKey: message.accessKey 
            }
        );
        if (!secretKey) {
            return {
                valid: false,
                error: "INVALID_ACCESS_KEY",
            }
        }

        return validateMessage(message, secretKey);

    }

    @Action({
        name: 'storeKeyPair',
        params: {
            accessKey: "string",
            secretKey: "string",
        },
    })
    protected async storeKeyPair(ctx: Context<{ accessKey: string; secretKey: string }, any>) {

        const { accessKey, secretKey } = ctx.params;

        const savedSecretKey = await this.actions.getStoredSecretKey({ accessKey });
        if (savedSecretKey && savedSecretKey !== secretKey) {
            throw new Errors.MoleculerError("INVALID_ACCESS_KEY", 400);
        }
        
        await this.db.put(accessKey, secretKey);

        return {
            success: true
        }

    }

    @Action({
        name: 'deleteKeyPair',
        params: {
            accessKey: "string",
        }
    })
    protected async deleteKeyPair(ctx: Context<{ accessKey: string }, any>) {

        const { accessKey } = ctx.params;
        await this.db.del(accessKey);

        await this.broker.cacher?.del(`$auth.getStoredSecretKey:${accessKey}`)

        return {
            success: true
        }

    }

    @Action({
        name: 'generateKeys',
    })
    public async generateKeys(ctx: Context<any, any>) {
        return { 
            accessKey: randomBytes(16).toString('base64url'),
            secretKey: randomBytes(32).toString('base64url')
        }
    }

    @Action({
        name: "getStoredSecretKey",
        params: {
            accessKey: "string",
        },
        cache: {
            keys: ["accessKey"],
            ttl: 3600
        },
    })
    protected async getStoredSecretKey(ctx: Context<{ accessKey: string }, any>) {

        const { accessKey } = ctx.params;

        return await this.db.get(accessKey)
            .catch((error) => {
                if (error.code === 'LEVEL_NOT_FOUND') {
                    return undefined;
                } else {
                    ctx.broker.logger.error(error);
                }
            });

    }

    protected started() {

        const dbPath = path.join(process.env.DATA ?? path.join(getRootDir(), 'data'), 'auth');
        mkdirSync(dbPath, { recursive: true });

        // Create a database
        this.db = new Level(dbPath, { valueEncoding: 'json' });

    }

}