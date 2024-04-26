import { Command } from '@commander-js/extra-typings';
import Channels from '@moleculer/channels';
import kleur from 'kleur';
import _ from 'lodash';
import { GenericObject, ServiceBroker } from 'moleculer';
import path from 'node:path';

import pkgInfo from '../package.json';
import SidecarService from './index.service.js';
import './lab/index.js';
import InterNamespaceMiddleware from './middlewares/inter-namespace.middleware.js';
import { dotSet, isPlainObject, normalizeEnvValue, resolveFilePath } from './uitls/index.js';

const logger = {
    info(message: string) {
        console.log(kleur.grey('[Runner]'), kleur.green().bold(message));
    },
    error(err: unknown) {
        if (err instanceof Error) {
            console.error(kleur.grey('[Runner]'), kleur.red().bold(err.message), err);
        } else {
            console.error(kleur.grey('[Runner]'), kleur.red().bold(err as string));
        }
    },
};

async function loadEnvFile(envfile?: string) {
    try {
        const dotenv = await import('dotenv');

        if (envfile) {
            dotenv.config({ path: envfile });
        } else {
            dotenv.config();
        }
    } catch (err) {
        throw new Error("The 'dotenv' package is not installed!");
    }
}

async function loadConfigFile(configfile?: string): Promise<GenericObject> {
    let filePath;

    if (configfile != null) {
        if (path.isAbsolute(configfile)) {
            filePath = resolveFilePath(configfile);
        } else {
            filePath = resolveFilePath(path.resolve(process.cwd(), configfile));
        }

        if (filePath == null) {
            return Promise.reject(new Error(`Config file not found: ${configfile}`));
        }
    }

    if (!filePath) {
        filePath = import.meta.resolve(path.resolve(process.cwd(), 'moleculer.config.json'));
    } else {
        filePath = filePath.startsWith('/') ? filePath : '/' + filePath;
    }

    if (filePath) {
        try {
            const mod = await import(filePath, {
                with: { type: 'json' },
            });
            return mod.default;
        } catch (_) {}
    }

    return {};
}

function mergeOptions(configFile: GenericObject) {
    let config = _.defaultsDeep(configFile, ServiceBroker.defaultOptions);
    config = overwriteFromEnv(config);
    return config;
}

function overwriteFromEnv(obj: GenericObject, prefix?: string) {
    for (const key of Object.keys(obj)) {
        const envName = ((prefix ? prefix + '_' : '') + key).toUpperCase();

        if (process.env[envName]) {
            obj[key] = normalizeEnvValue(process.env[envName]);
        }

        if (isPlainObject(obj[key])) {
            obj[key] = overwriteFromEnv(obj[key], (prefix ? prefix + '_' : '') + key);
        }
    }

    // Process MOL_ env vars only the root level
    if (prefix == null) {
        const moleculerPrefix = 'MOL_';
        const variables = Object.keys(process.env)
            .filter((key) => key.startsWith(moleculerPrefix))
            .map((key) => ({
                key,
                withoutPrefix: key.substring(moleculerPrefix.length),
            }));
        for (const variable of variables) {
            const dotted = variable.withoutPrefix
                .split('__')
                .map((level) => level.toLocaleLowerCase())
                .map((level) =>
                    level
                        .split('_')
                        .map((value, index) => {
                            if (index == 0) {
                                return value;
                            } else {
                                return value[0].toUpperCase() + value.substring(1);
                            }
                        })
                        .join(''),
                )
                .join('.');
            obj = dotSet(obj, dotted, normalizeEnvValue(process.env[variable.key]));
        }
    }

    return obj;
}

const options = new Command()
    .option('-e, --env', 'Load .env file from the current directory')
    .option('--envfile <envfile>', 'Load a specified .env file')
    .option('-c, --config', 'Load the configuration from a file')
    .option('--configfile <configfile>', 'Load a specified configuration file')
    .option('--inter', 'Use inter-namespace middleware')
    .version(
        `sidecar: ${pkgInfo.version}\nmoleculer: ${ServiceBroker.MOLECULER_VERSION}`,
        '-v, --version',
        'Output the current version',
    )
    .parse(process.argv)
    .opts();

if (options.env || options.envfile) {
    await loadEnvFile(options.envfile);
}

const configFile =
    process.env['MOLECULER_CONFIG'] || options.config || options.configfile
        ? await loadConfigFile(process.env['MOLECULER_CONFIG'] || options.configfile)
        : {};

const config = mergeOptions(configFile);
if (!config.middlewares) {
    config.middlewares = [];
}
if (options.inter) {
    config.middlewares.push(
        InterNamespaceMiddleware([
            {
                brokerOptions: {
                    nodeID: process.env['INTER_NODEID'],
                    namespace: process.env['INTER_NAMESPACE'],
                    transporter: process.env['INTER_TRANSPORTER'],
                    logLevel: {
                        BROKER: 'warn',
                        REGISTRY: 'warn',
                        TRACER: 'warn',
                        TRANSPORTER: 'trace',
                        '*': 'trace',
                    },
                    requestTimeout: 0,
                },
            },
        ]),
    );
}
if (process.env.CHANNELS_ADAPTER_NATS) {
    config.middlewares.push(
        Channels.Middleware({
            adapter: {
                type: 'NATS',
                options: {
                    nats: {
                        url: process.env.CHANNELS_ADAPTER_NATS,
                        deadLettering: {
                            enabled: true,
                            queueName: 'DEAD_LETTER',
                        },
                    },
                },
            },
        }),
        Channels.Tracing(),
    );
}

const broker = new ServiceBroker(Object.assign({}, config));
broker.createService(SidecarService);

await broker.start().catch((err) => {
    logger.error(err);
    process.exit(1);
});
