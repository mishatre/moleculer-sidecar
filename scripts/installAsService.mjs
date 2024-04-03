import { Service } from 'node-windows';
import path from 'node:path';
import url from 'node:url';
import pkgJSON from "../package.json"

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a new service object
const svc = new Service({
  name: pkgJSON.name,
  description: pkgJSON.description,
  script: path.join(__dirname, '../build/index.js'),
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install', () => {
    console.log("install")
    svc.start();
});

svc.install();