import { action, defineSettings, service, started } from 'moldecor';
import { type Context, Service as MoleculerService } from 'moleculer';
import { parse } from 'yaml';

const settings = defineSettings({});

@service({
    name: '$sidecar.utils',

    metadata: {
        $description: ``,
        $author: 'Mikhail Tregub',
        $official: false,
    },

    settings,
})
export default class SidecarUtilsService extends MoleculerService<typeof settings> {
    @action({
        name: 'parseYAML',
        params: {
            string: 'string',
        },
    })
    public parseYAML(ctx: Context<{ string: string }>) {
        return parse(ctx.params.string);
    }

    @started
    public async started() {}
}
