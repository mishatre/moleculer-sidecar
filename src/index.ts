import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import kleur from 'kleur';
import _ from 'lodash';
import { type BrokerOptions, ServiceBroker, type ServiceSchema } from 'moleculer';
import { z } from 'zod';

const CLI_NAME = 'moleculer-sidecar';
const DEFAULT_CONFIG_FILE = 'moleculer.config.ts';
const DEFAULT_ENV_FILE = '.env';

const coreServices = [
    async () => (await import('./services/auth.service.js')).default,
    async () => (await import('./services/utils.service.js')).default,
    async () => (await import('./services/sidecar.service.js')).default,
];

const optionalServices = {
    lab: async () => (await import('./services/lab.service.js')).default,
    ui: async () => (await import('./services/ui.service.js')).default,
} as const;

const cliOptionsSchema = z.object({
    config: z.string().trim().min(1).optional(),
    envfile: z.string().trim().min(1).optional(),
    lab: z.boolean().default(false),
    ui: z.boolean().default(false),
    nodeId: z.string().trim().min(1).optional(),
    namespace: z.string().optional(),
    logLevel: z.string().trim().min(1).optional(),
    transporter: z.string().trim().min(1).optional(),
    repl: z.boolean().default(false),
    help: z.boolean().default(false),
    version: z.boolean().default(false),
});

const scalarValueSchema = z.string().transform((raw): unknown => {
    const lower = raw.toLowerCase();
    if (lower === 'true' || lower === 'false') return lower === 'true';
    if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
    return raw;
});

export type CliOptions = z.infer<typeof cliOptionsSchema>;
export type OptionalService = keyof typeof optionalServices;

export function parseCliArgs(argv: readonly string[]): CliOptions {
    const args = argv[0] === '--' ? argv.slice(1) : argv;
    const { values } = parseArgs({
        args: [...args],
        options: {
            config: { type: 'string', short: 'c' },
            envfile: { type: 'string', short: 'E' },
            lab: { type: 'boolean' },
            ui: { type: 'boolean' },
            'node-id': { type: 'string' },
            namespace: { type: 'string' },
            'log-level': { type: 'string' },
            transporter: { type: 'string' },
            repl: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
        },
        allowPositionals: false,
        strict: true,
    });

    return cliOptionsSchema.parse({
        config: values.config,
        envfile: values.envfile,
        lab: values.lab,
        ui: values.ui,
        nodeId: values['node-id'],
        namespace: values.namespace,
        logLevel: values['log-level'],
        transporter: values.transporter,
        repl: values.repl,
        help: values.help,
        version: values.version,
    });
}

export function resolveEnvFile(
    options: CliOptions,
    cwd: string = process.cwd(),
): string | undefined {
    if (options.envfile) {
        const file = path.resolve(options.envfile);
        if (!existsSync(file)) {
            throw new Error(`env file not found: ${file}`);
        }
        return file;
    }

    const fallback = path.join(cwd, DEFAULT_ENV_FILE);
    return existsSync(fallback) ? fallback : undefined;
}

export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): void {
    const { error } = dotenv.config({ path: file, processEnv: env as Record<string, string> });
    if (error) {
        throw new Error(`cannot load env file ${file}: ${error.message}`);
    }
}

function isEnabled(value: string | undefined): boolean {
    if (value == null) return false;
    return !['', '0', 'false', 'no'].includes(value.trim().toLowerCase());
}

export function resolveOptionalServices(
    options: CliOptions,
    env: NodeJS.ProcessEnv = process.env,
): OptionalService[] {
    const names = Object.keys(optionalServices) as OptionalService[];
    return names.filter((name) => options[name] || isEnabled(env[name.toUpperCase()]));
}

export function applyEnvOverrides(
    config: BrokerOptions,
    env: NodeJS.ProcessEnv = process.env,
): void {
    const target = config as Record<string, unknown>;
    for (const key of Object.keys(target)) {
        const value = env[key.toUpperCase()];
        if (value) {
            target[key] = scalarValueSchema.parse(value);
        }
    }
}

export function buildBrokerOptions(
    config: BrokerOptions,
    options: CliOptions,
    env: NodeJS.ProcessEnv = process.env,
): BrokerOptions {
    const merged = _.defaultsDeep(config, ServiceBroker.defaultOptions) as BrokerOptions;

    applyEnvOverrides(merged, env);

    if (options.nodeId) merged.nodeID = options.nodeId;
    if (options.namespace !== undefined) merged.namespace = options.namespace;
    if (options.logLevel) merged.logLevel = options.logLevel as BrokerOptions['logLevel'];
    if (options.transporter) merged.transporter = options.transporter;

    return merged;
}

export function resolveConfigFile(
    options: CliOptions,
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string {
    const requested = options.config ?? env.MOLECULER_CONFIG?.trim();
    const file = requested ? path.resolve(requested) : path.join(cwd, DEFAULT_CONFIG_FILE);
    if (!existsSync(file)) {
        throw new Error(`config file not found: ${file}`);
    }
    return file;
}

export async function loadBrokerConfig(file: string): Promise<BrokerOptions> {
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const content = module.default;

    if (content == null) {
        throw new Error(`config file ${file} has no default export`);
    }

    const config = typeof content === 'function' ? await (content as () => unknown)() : content;
    if (!_.isPlainObject(config)) {
        throw new Error(`config file ${file} must export an object or a factory`);
    }

    return config as BrokerOptions;
}

async function loadService(load: () => Promise<unknown>): Promise<ServiceSchema> {
    const service = await load();
    if (service == null) {
        throw new Error('service module has no default export');
    }
    return service as ServiceSchema;
}

function readVersion(): string {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: string;
    };
    return pkg.version ?? '0.0.0';
}

function formatError(error: unknown): string {
    if (error instanceof z.ZodError) {
        return error.issues
            .map((issue) => {
                const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
                return `${location}${issue.message}`;
            })
            .join('\n');
    }
    if (error instanceof Error) return error.message;
    return String(error);
}

function log(message: string): void {
    console.log(`${kleur.grey(`[${CLI_NAME}]`)} ${message}`);
}

export function usageText(): string {
    const optional = Object.keys(optionalServices).join(', ');
    return `Usage: ${CLI_NAME} [options]

Options:
  -c, --config <file>       Broker config file [default: ./${DEFAULT_CONFIG_FILE}]
                            [env: MOLECULER_CONFIG]
  -E, --envfile <file>      Env file to load [default: ./${DEFAULT_ENV_FILE} when present]
      --lab                 Start the lab monitoring agent [env: LAB]
      --ui                  Start the access-token admin UI [env: UI]
      --node-id <id>        Broker nodeID
      --namespace <ns>      Broker namespace ("" clears it)
      --log-level <level>   Broker logLevel
      --transporter <spec>  Transporter URL or built-in name
      --repl                Start a REPL once the broker is running
  -h, --help                Show this help
  -v, --version             Print the package version

Core services: $sidecar.auth, $sidecar.utils, $sidecar (always started)
Optional services: ${optional}

Any top-level broker option can be set from the environment with its
upper-case name (NODEID, NAMESPACE, LOGLEVEL, TRANSPORTER, REQUESTTIMEOUT, ...).

Examples:
  ${CLI_NAME}
  ${CLI_NAME} --lab
  ${CLI_NAME} --envfile /etc/sidecar/env --node-id sidecar-1`;
}

export async function main(
    argv: readonly string[] = process.argv.slice(2),
    env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceBroker | undefined> {
    const options = parseCliArgs(argv);

    if (options.help) {
        console.log(usageText());
        return undefined;
    }
    if (options.version) {
        console.log(readVersion());
        return undefined;
    }

    const envFile = resolveEnvFile(options);
    if (envFile) loadEnvFile(envFile, env);

    const configFile = resolveConfigFile(options, env);
    const brokerOptions = buildBrokerOptions(await loadBrokerConfig(configFile), options, env);

    log(`config: ${configFile}`);

    const broker = new ServiceBroker(brokerOptions);
    const started: string[] = [];
    const enabled = resolveOptionalServices(options, env).map((name) => optionalServices[name]);
    for (const load of [...coreServices, ...enabled]) {
        started.push(broker.createService(await loadService(load)).name);
    }

    await broker.start();
    log(`started ${broker.nodeID}: ${started.join(', ')}`);

    if (options.repl) broker.repl();

    return broker;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
const isEntryPoint =
    process.platform === 'win32'
        ? entryPath.toLowerCase() === modulePath.toLowerCase()
        : entryPath === modulePath;

if (isEntryPoint) {
    main().catch((error: unknown) => {
        console.error(`${kleur.grey(`[${CLI_NAME}]`)} ${kleur.red(formatError(error))}`);
        process.exit(1);
    });
}
