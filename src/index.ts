import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import kleur from 'kleur';
import _ from 'lodash';
import type { BrokerOptions, ServiceSchema } from 'moleculer';
import { z } from 'zod';
import { ServiceBroker } from './runtime/cjs-interop.js';
import { loadModuleFile } from './runtime/module-loader.js';
import { findAppRoot, isMainModule, isPackaged } from './runtime/paths.js';
import { startPglite, stopPglite } from './runtime/pglite.js';
import { installUrlAwareFs } from './runtime/vfs-fs.js';

// The packaged filesystem resolves path strings only, so dependencies that read
// their own files by URL (lab's pglite reads its wasm/data that way) need the
// argument normalised before they touch the patched fs functions.
//
// This has to happen *before* such a dependency is instantiated: an ES module
// namespace snapshots `fs/promises` at load time, so anything that destructures
// it earlier keeps the unpatched helper. That is why a dependency of this kind
// must be imported through a runtime specifier (see `src/services/lab.service.ts`)
// rather than as a static import, which a bundler hoists above this code.
if (isPackaged()) {
    installUrlAwareFs();
}

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

/** Compiled broker config that ships inside the packaged binary, if present. */
export function bundledConfigFile(root: string = findAppRoot()): string | undefined {
    return ['dist/moleculer.config.mjs', 'moleculer.config.mjs']
        .map((candidate) => path.join(root, candidate))
        .find((candidate) => existsSync(candidate));
}

export function resolveConfigFile(
    options: CliOptions,
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string {
    const requested = options.config ?? env.MOLECULER_CONFIG?.trim();
    if (requested) {
        const file = path.resolve(requested);
        if (!existsSync(file)) {
            throw new Error(`config file not found: ${file}`);
        }
        return file;
    }

    const local = path.join(cwd, DEFAULT_CONFIG_FILE);
    if (existsSync(local)) {
        return local;
    }

    // A packaged binary falls back to the config compiled into it; that only
    // applies when the caller supplied neither --config nor the env var.
    const bundled = bundledConfigFile();
    if (bundled) {
        return bundled;
    }

    throw new Error(`config file not found: ${local}`);
}

export async function loadBrokerConfig(file: string): Promise<BrokerOptions> {
    const module = (await loadModuleFile(file)) as { default?: unknown };
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
    // Compiled output sits one level deeper than the sources, so the manifest is
    // located instead of counted relative to this module.
    const pkg = JSON.parse(readFileSync(path.join(findAppRoot(), 'package.json'), 'utf8')) as {
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
  -c, --config <file>       Broker config file [default: ./${DEFAULT_CONFIG_FILE},
                            or the config bundled into the binary]
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
    // The socket must be listening before the service modules are imported:
    // each DbService reads the connection details at decoration time.
    await startPglite();
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

/** How long a stop request may take before the process exits regardless. */
const SHUTDOWN_TIMEOUT_MS = 15 * 1000;

/**
 * Stops the broker and exits. Service managers (NSSM, systemd, launchd) ask for
 * a stop by sending a console signal, so the process has to answer it instead of
 * being killed mid-flight.
 */
export async function stopBroker(
    broker: ServiceBroker,
    exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
    const forcedExit = setTimeout(() => {
        log('shutdown timed out, exiting anyway');
        exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forcedExit.unref();

    try {
        await broker.stop();
        await stopPglite();
        clearTimeout(forcedExit);
        log(`stopped ${broker.nodeID}`);
        exit(0);
    } catch (error: unknown) {
        clearTimeout(forcedExit);
        console.error(`${kleur.grey(`[${CLI_NAME}]`)} ${kleur.red(formatError(error))}`);
        exit(1);
    }
}

/** Installs the stop signals once the broker is running. */
export function installShutdownHandlers(broker: ServiceBroker): void {
    let stopping = false;
    const handle = (signal: NodeJS.Signals) => {
        if (stopping) {
            return;
        }
        stopping = true;
        log(`received ${signal}, stopping ${broker.nodeID}...`);
        void stopBroker(broker);
    };

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    if (process.platform === 'win32') {
        signals.push('SIGBREAK');
    }

    for (const signal of signals) {
        process.on(signal, () => handle(signal));
    }
}

/**
 * Runs the CLI and wires up the stop signals. Shared by the source entry point
 * and the packaged bundle (src/cli.ts), which never needs the entry check.
 */
export function runCli(): void {
    main()
        .then((broker) => {
            if (broker) {
                installShutdownHandlers(broker);
            }
        })
        .catch((error: unknown) => {
            console.error(`${kleur.grey(`[${CLI_NAME}]`)} ${kleur.red(formatError(error))}`);
            process.exit(1);
        });
}

// A packaged binary is always the entry point: its argv[1] points into the
// snapshot while this module is the executable itself.
const thisFile = fileURLToPath(import.meta.url);

if (isPackaged() || isMainModule(thisFile)) {
    runCli();
}
