import { action, event, service, started } from 'moldecor';
import { Context, Service as MoleculerService } from 'moleculer';
interface Settings {}

@service({
    name: 'sidecar.prod.test',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    settings: {},
})
export default class SidecarTestService extends MoleculerService<Settings> {
    // @event({
    //     name: 'infobase.change',

    //     context: true,
    // })
    // public onInfobaseDocumentChange(ctx: Context) {
    //     this.logger.warn(ctx.event?.name);
    //     this.logger.warn(JSON.stringify(ctx.params, undefined, '    '));
    // }

    @action({
        name: 'generateAccessKey',
    })
    public generateAccessKey(ctx: Context) {
        return ctx.call('$sidecar.auth.generateAccessKey');
    }

    @started
    public async started() {}
}
