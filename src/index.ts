import '@moleculer/lab';
import { config } from 'dotenv';
import { ServiceBroker } from 'moleculer';
import path from 'node:path';

import ApiService from './services/api.service.js';
import LabService from './services/lab.service.js';
import NodesService from './services/nodes.service.js';
import SidecarService from './services/sidecar.service.js';
import { overwriteFromEnv } from './uitls/env.js';
import { getRootDir } from './uitls/index.js';

console.log(path.join(getRootDir(), '.env'));
config({
    path: path.join(getRootDir(), '.env'),
});

async function main() {
    const config = overwriteFromEnv(ServiceBroker.defaultOptions);

    // Create service broker
    const broker = new ServiceBroker(Object.assign({}, config));

    const services = [];
    // services.push(broker.createService(ApiService));
    services.push(broker.createService(LabService));
    services.push(broker.createService(NodesService));
    services.push(broker.createService(SidecarService));

    await Promise.allSettled(services);

    await broker.start();
}

main();
