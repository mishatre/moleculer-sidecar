import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { getRootDir } from './index.js';

const catalog = process.env.DATA ?? path.join(getRootDir(), 'data');

export function initDatabaseCatalog() {
    mkdirSync(catalog, { recursive: true });
}

export function getDatabasePath(name: string) {
    return path.join(catalog, name);
}
