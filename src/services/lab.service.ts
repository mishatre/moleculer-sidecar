// @ts-ignore
import LabAgent from '@moleculer/lab';
import { service } from 'moldecor';
import { Service as MoleculerService } from 'moleculer';

@service({
    name: 'lab',
    mixins: [LabAgent.AgentService],
    settings: {
        token: process.env.LAB_TOKEN,
        apiKey: process.env.LAB_API_KEY,
    },
})
export default class LabAgentService extends MoleculerService {}
