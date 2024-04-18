import _ from 'lodash';
import Moleculer, {
    BaseMetric,
    GenericObject,
    LoggerBindings,
    LoggerFactory,
    LoggerInstance,
    MetricListOptions,
    MetricRegistry,
    MetricReporterOptions,
    ServiceBroker,
    Span,
    Tracer,
    Utils,
} from 'moleculer';
import { inspect, promisify } from 'node:util';
import { deflate as deflate_callback } from 'node:zlib';

const deflate = promisify(deflate_callback);

declare module 'moleculer' {
    export namespace MetricReporters {
        class Laboratory extends LabEventReporter {}
    }
    export namespace TracerExporters {
        class Laboratory extends LabEventExporter {}
    }
    export namespace Loggers {
        class Laboratory extends Loggers.Base {}
        const LEVELS: string[];
    }
}

const Reporters = Moleculer.MetricReporters;
const Exporters = Moleculer.TracerExporters;
const Loggers = Moleculer.Loggers;

class LabEventReporter extends Reporters.Base {
    private registry!: MetricRegistry;
    private logger!: LoggerInstance;
    private broker!: ServiceBroker;
    private lastChanges: Set<string>;
    private timer: NodeJS.Timeout | undefined;

    constructor(opts: MetricReporterOptions) {
        super(opts);
        this.opts = _.defaultsDeep(this.opts, {
            broadcast: true,
            onlyChanges: true,
            interval: 10,
            compress: true,
        });
        this.lastChanges = new Set();
    }
    init(registry: MetricRegistry) {
        super.init(registry);
        if (this.opts.interval > 0) {
            this.timer = setInterval(() => this.sendEvent(), 1e3 * this.opts.interval);
            this.timer.unref();
        }
    }
    async sendEvent() {
        let data;
        let list = this.registry.list({
            includes: this.opts.includes!,
            excludes: this.opts.excludes!,
        } as unknown as MetricListOptions);

        if (this.opts.onlyChanges) {
            list = list.filter((metric) => this.lastChanges.has(metric.name));
        }
        this.lastChanges.clear();

        if (0 != list.length) {
            if (this.opts.compress) {
                const json = JSON.stringify(list);
                data = Buffer.from(await deflate(json));
            } else {
                data = list;
            }
            if (this.opts.broadcast) {
                this.logger.debug(
                    `Send metrics.snapshot (${list.length} metrics) broadcast event.`,
                );
                this.broker.broadcast('$lab.metrics.changes', data, {
                    groups: this.opts.groups,
                });
            } else {
                this.logger.debug(`Send metrics.snapshot (${list.length} metrics) event.`);
                this.broker.emit('$lab.metrics.changes', data, {
                    groups: this.opts.groups,
                });
            }
        }
    }
    metricChanged(metric: BaseMetric) {
        this.matchMetricName(metric.name) && this.lastChanges.add(metric.name);
    }
}

class LabEventExporter extends Exporters.Base {
    public declare broker: ServiceBroker;
    public declare timer: NodeJS.Timeout | null;
    private declare defaultTags: Function | any;
    private declare Promise: PromiseConstructor;
    private queue: Span[];

    constructor(opts: GenericObject) {
        super(opts);
        this.opts = _.defaultsDeep(this.opts, {
            broadcast: true,
            interval: 10,
            compress: true,
            defaultTags: null,
        });
        this.queue = [];
    }
    init(tracer: Tracer) {
        super.init(tracer);
        if (this.opts.interval > 0) {
            this.timer = setInterval(() => this.flush(), 1e3 * this.opts.interval);
            this.timer.unref();
        }
        this.defaultTags = _.isFunction(this.opts.defaultTags)
            ? this.opts.defaultTags.call(this, tracer)
            : this.opts.defaultTags;
    }
    stop() {
        return (
            this.timer && (clearInterval(this.timer), (this.timer = null)), this.Promise.resolve()
        );
    }
    spanFinished(span: Span) {
        this.queue.push(span), this.timer || this.flush();
    }
    async flush() {
        if (0 == this.queue.length) {
            return;
        }
        const list = this.generateTracingData();
        let data;
        if (((this.queue.length = 0), this.opts.compress)) {
            const json = JSON.stringify(list);
            data = Buffer.from(await deflate(json));
        } else {
            data = list;
        }
        if (this.opts.broadcast) {
            this.logger.debug(`Send tracing spans (${list.length} spans) broadcast event.`),
                this.broker.broadcast('$lab.tracing.spans', data, {
                    groups: this.opts.groups,
                });
        } else {
            this.logger.debug(`Send tracing spans (${list.length} spans) event.`);
            this.broker.emit('$lab.tracing.spans', data, {
                groups: this.opts.groups,
            });
        }
    }
    generateTracingData() {
        return Array.from(this.queue).map((span) => {
            const newSpan = Utils.safetyObject(span);
            if (newSpan.error) {
                newSpan.error = this.errorToObject(newSpan.error);
            }
            return newSpan;
        });
    }
}

class LabEventLogger extends Loggers.Base {
    public declare broker: ServiceBroker;
    public declare opts: GenericObject;
    public declare queue: GenericObject[];
    public declare timer: NodeJS.Timeout | null;
    private declare Promise: PromiseConstructor;

    private declare objectPrinter: (object: unknown) => string;

    constructor(opts: GenericObject) {
        super(opts);
        this.opts = _.defaultsDeep(this.opts, {
            broadcast: true,
            interval: 10,
            compress: true,
            objectPrinterDepth: 2,
        });
        this.queue = [];
        this.timer = null;
        this.objectPrinter = (o) =>
            inspect(o, {
                showHidden: false,
                depth: this.opts.objectPrinterDepth,
                colors: false,
                breakLength: Number.POSITIVE_INFINITY,
            });
    }
    init(loggerFactory: LoggerFactory) {
        super.init(loggerFactory),
            this.opts.interval > 0 &&
                ((this.timer = setInterval(() => this.sendLogEntries(), 1e3 * this.opts.interval)),
                this.timer.unref());
    }
    stop() {
        return this.timer && clearInterval(this.timer), this.Promise.resolve();
    }
    printArgs(args: unknown[]) {
        return args.map((p) => (_.isObject(p) || Array.isArray(p) ? this.objectPrinter(p) : p));
    }
    getLogHandler(bindings: LoggerBindings) {
        const level = bindings ? this.getLogLevel(bindings.mod) : null;
        if (!level) {
            return null;
        }
        const levelIdx = Loggers.LEVELS.indexOf(level);
        return (type: string, args: unknown[]) => {
            if (Loggers.LEVELS.indexOf(type) > levelIdx) {
                return;
            }
            const message = this.printArgs(args)
                .join(' ')
                .replace(/\u001b\[.*?m/g, '');
            this.queue.push({
                ts: Date.now(),
                ...bindings,
                level: type,
                message: message,
            });
        };
    }
    async sendLogEntries() {
        const list = Array.from(this.queue);
        if (((this.queue.length = 0), 0 == list.length)) {
            return;
        }
        let data;
        if (this.opts.compress) {
            const json = JSON.stringify(list);
            data = Buffer.from(await deflate(json));
        } else {
            data = list;
        }
        if (this.opts.broadcast) {
            this.broker.broadcast('$lab.log.entries', data, {
                groups: this.opts.groups,
            });
        } else {
            this.broker.emit('$lab.log.entries', data, {
                groups: this.opts.groups,
            });
        }
    }
}

Reporters.Laboratory = LabEventReporter;
Exporters.Laboratory = LabEventExporter;
Loggers.Laboratory = LabEventLogger;

const MetricReporter = LabEventReporter;
const TraceExporter = LabEventExporter;
const EventLogger = LabEventLogger;

export { MetricReporter, TraceExporter, EventLogger };
