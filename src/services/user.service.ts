
import { Context, Service as MoleculerService, Errors } from 'moleculer';
import { Service, Method, Action } from 'moleculer-decorators';

@Service({
    name: "user",

    settings: {
    }
})
export default class UserService extends MoleculerService {

    @Action({
        name: "createKeyPair"
    })
    async createKeyPair(ctx: Context) {
        const { accessKey, secretKey } = await ctx.call<{ accessKey: string; secretKey: string }>("$auth.generateKeys");
        await ctx.call("$auth.storeKeyPair", { accessKey, secretKey });
        return {
            accessKey,
            secretKey
        };
    }
}