// @ts-ignore
import Laboratory from '@moleculer/lab';
import { config } from 'dotenv';
import { Service as MoleculerService } from 'moleculer';
import { Service } from 'moleculer-decorators';

config();

@Service({
    name: 'lab',
    mixins: [Laboratory.AgentService],

    settings: {
        token: 'secret',
        apiKey: process.env.LABORATORY_API_KEY,
    },
})
export default class LabService extends MoleculerService {}
