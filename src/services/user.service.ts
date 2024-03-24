
import { Context, Service as MoleculerService, Errors } from 'moleculer';
import { Service, Method, Action } from 'moleculer-decorators';

@Service({
    name: "user",

    settings: {
    }
})
export default class UserService extends MoleculerService {

}