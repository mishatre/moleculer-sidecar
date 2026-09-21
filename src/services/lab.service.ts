// @ts-expect-error
import LabAgent from '@moleculer/lab';
import { defineSettings, service } from 'moldecor';
import { Service as MoleculerService } from 'moleculer';

const settings = defineSettings({
    token: process.env.LAB_TOKEN,
    apiKey: process.env.LAB_API_KEY,
});

@service({
    name: 'lab',
    mixins: [LabAgent.AgentService],
    settings,
})
export default class LabAgentService extends MoleculerService<typeof settings> {}
