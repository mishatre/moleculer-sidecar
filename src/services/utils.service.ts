import { action, defineSettings, service, started } from 'moldecor';
import type { Context } from 'moleculer';
import { parse } from 'yaml';
import { Service as MoleculerService } from '../runtime/cjs-interop.js';

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
