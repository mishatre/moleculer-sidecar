import { method, service } from 'moldecor';
import { Context, Service as MoleculerService } from 'moleculer';
import { IncomingMessage } from '../types.js';
import { ERR_INVALID_TOKEN, ERR_NO_TOKEN, UnAuthorizedError } from '../errors.js';

@service({
    name: 'authorize-mixin',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    dependencies: ['$sidecar.auth'],
})
export default class AuthorizeMixin extends MoleculerService {
    @method
    protected async authorize(ctx: Context, req: IncomingMessage): Promise<Context> {
        let auth = req.headers['authorization'];
        if (!auth) {
            // No token
            return Promise.reject(new UnAuthorizedError(ERR_NO_TOKEN, null));
        }

        return ctx
            .call('$sidecar.auth.verifyRequest', { req }, { parentCtx: ctx })
            .then((valid) => {
                if (!valid) {
                    return Promise.reject(new UnAuthorizedError(ERR_INVALID_TOKEN, undefined));
                }
                return Promise.resolve(ctx);
            })
            .catch((error) => {
                return Promise.reject(new UnAuthorizedError(ERR_INVALID_TOKEN, error));
            });
    }
}
