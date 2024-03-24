
// @ts-ignore
import Laboratory from '@moleculer/lab';
import { Service as MoleculerService } from "moleculer";
import { Service } from "moleculer-decorators";

@Service({
    name: "lab",
    mixins: [Laboratory.AgentService],

    settings: {
        token: "secret",
        apiKey: process.env.LABORATORY_API_KEY
    }
})
export default class LabService extends MoleculerService {}
