import { action, defineSettings, event, service, started } from 'moldecor';
import { type Context, Service as MoleculerService } from 'moleculer';

const settings = defineSettings({});

@service({
    name: 'sidecar.prod.test',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    settings,
})
export default class SidecarTestService extends MoleculerService<typeof settings> {
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
