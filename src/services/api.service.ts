import { Context, Errors, Service as MoleculerService } from 'moleculer';
import { Method, Service } from 'moleculer-decorators';
import ApiGateway, { GatewayResponse, IncomingRequest, Route } from 'moleculer-web';

const WebErrors = ApiGateway.Errors;

@Service({
    name: '$api',
    mixins: [ApiGateway],

    settings: {
        port: process.env.WEB_PORT != null ? process.env.WEB_PORT : 8080,
        path: '/',

        assets: {
            folder: './app/out',
        },

        routes: [
            {
                path: '/api',

                mappingPolicy: 'restrict',

                bodyParsers: {
                    json: true,
                },

                // Set CORS headers
                cors: true,

                aliases: {
                    // "GET /registry/nodes": "$node.list",
                },

                autoAliases: false,
                authorization: true,
            },
        ],
    },
})
class ApiGatewayService extends MoleculerService {
    @Method
    // @ts-ignore 6133
    private async authorize(
        ctx: Context<{}, { user: Object; token: string; userID: string }>,
        route: Route,
        req: IncomingRequest,
        res: GatewayResponse,
    ): Promise<Context> {
        let auth = req.headers['authorization'];
        if (!auth) {
            // No token
            return Promise.reject(
                this.newResponse(new WebErrors.UnAuthorizedError(WebErrors.ERR_NO_TOKEN, null)),
            );
        }

        let [type, token] = auth.split(' ');
        if (type !== 'Token' && type !== 'Bearer') {
            // Invalid auth type
            return Promise.reject(
                this.newResponse(
                    new WebErrors.UnAuthorizedError(WebErrors.ERR_UNABLE_DECODE_PARAM, null),
                ),
            );
        }

        if (!token) {
            // No token
            return Promise.reject(
                this.newResponse(new WebErrors.UnAuthorizedError(WebErrors.ERR_NO_TOKEN, null)),
            );
        }

        let user;
        // Verify JWT token
        try {
            // user = await ctx.call("users.resolveToken", { token });
            // if (user) {
            //     this.logger.info("Authenticated via JWT: ", user.username);
            //     // Reduce user fields (it will be transferred to other nodes)
            //     ctx.meta.user = _.pick(user, ["_id", "username", "email", "image"]);
            //     ctx.meta.token = token;
            //     ctx.meta.userID = user._id;
            // }
        } catch (err) {
            // Ignored because we continue processing if user doesn't exists
        }

        if (req.$action.auth == 'required' && !user) {
            return Promise.reject(new WebErrors.UnAuthorizedError('UNAUTHORIZED', 'No user found'));
        }

        return Promise.resolve(ctx);
    }

    @Method
    private newResponse(error?: Errors.MoleculerError, result?: any) {
        return {
            error,
            result,
        };
    }

    protected async created() {
        this.services = new Map();
    }
}

export default ApiGatewayService;
