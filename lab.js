"use strict";
var require$$0$2 = require("socket.io"),
  require$$1$1 = require("kleur"),
  require$$2$1 = require("crypto"),
  require$$0$1 = require("lodash"),
  require$$2$2 = require("zlib"),
  require$$3 = require("util"),
  require$$0 = require("moleculer"),
  require$$1 = require("sqlite3"),
  require$$2 = require("path"),
  require$$4$1 = require("fs");
function _interopDefaultLegacy(e) {
  return e && "object" == typeof e && "default" in e ? e : { default: e };
}
var require$$0__default$2 = _interopDefaultLegacy(require$$0$2),
  require$$1__default$1 = _interopDefaultLegacy(require$$1$1),
  require$$2__default$1 = _interopDefaultLegacy(require$$2$1),
  require$$0__default$1 = _interopDefaultLegacy(require$$0$1),
  require$$2__default$2 = _interopDefaultLegacy(require$$2$2),
  require$$3__default = _interopDefaultLegacy(require$$3),
  require$$0__default = _interopDefaultLegacy(require$$0),
  require$$1__default = _interopDefaultLegacy(require$$1),
  require$$2__default = _interopDefaultLegacy(require$$2),
  require$$4__default = _interopDefaultLegacy(require$$4$1),
  require$$4 = {
    name: "@moleculer/lab",
    version: "0.6.4",
    main: "dist/index.js",
    scripts: {
      dev: 'node --inspect="0.0.0.0:9229" node_modules/moleculer/bin/moleculer-runner.js --repl --hot --config example/moleculer.config.js example/services/agent.service.js example/services/api.service.js example/services/greeter.service.js example/services/helper.service.js',
      "dev:agent":
        'node --inspect="0.0.0.0:9229" node_modules/moleculer/bin/moleculer-runner.js --repl --hot --config example/moleculer.config.js example/services/agent.service.js',
      "dev:full":
        'node --inspect="0.0.0.0:9229" node_modules/moleculer/bin/moleculer-runner.js --repl --hot --config example/moleculer.config.js example/services/**.service.js',
      "dev:brutal": 'node --inspect="0.0.0.0:9229" example/brutal.js',
      build: "rollup -c",
      deps: "npm-check -u",
      prepublishOnly: "npm run build",
      release: "npm publish --access public",
    },
    author: "MoleculerJS",
    dependencies: {
      kleur: "^4.1.5",
      lodash: "^4.17.21",
      "socket.io": "^2.4.1",
      sqlite3: "^5.1.2",
    },
    devDependencies: {
      "@rollup/plugin-commonjs": "^20.0.0",
      "@rollup/plugin-json": "^4.1.0",
      axios: "^0.21.3",
      eslint: "^7.32.0",
      "eslint-config-prettier": "^8.5.0",
      "eslint-plugin-node": "^11.1.0",
      "eslint-plugin-prettier": "^4.2.1",
      "eslint-plugin-promise": "^5.1.0",
      "eslint-plugin-security": "^1.5.0",
      fakerator: "^0.3.6",
      ioredis: "^4.27.9",
      moleculer: "^0.14.24",
      "moleculer-db": "^0.8.19",
      "moleculer-repl": "^0.7.3",
      "moleculer-web": "^0.10.4",
      nats: "^2.8.0",
      "npm-check": "^5.9.2",
      prettier: "^2.7.1",
      rollup: "^2.56.3",
      "rollup-plugin-terser": "^7.0.2",
    },
  };
const _$7 = require$$0__default$1.default,
  sqlite3 = require$$1__default.default,
  path = require$$2__default.default,
  { makeDirs: makeDirs } = require$$0__default.default.Utils,
  fs = require$$4__default.default.promises;
var abstractStore = class {
  constructor(service, opts) {
    (this.opts = _$7.defaultsDeep(opts, { persistent: false, folder: null })),
      (this.service = service),
      (this.broker = this.service.broker),
      (this.logger = service.logger),
      (this.Promise = service.Promise),
      (this.name = null),
      (this.db = null),
      (this.cleanTimer = null),
      (this.queue = []),
      (this.queueTimer = null),
      (this.processing = false);
  }
  getDBName() {
    throw new Error("Abstract method");
  }
  createTablesSQL() {}
  async connect(project) {
    this.project = project;
    const dbName = this.getDBName(project);
    let filename,
      db,
      shouldCreateTables = false;
    if (this.opts.persistent) {
      (filename = path.join(this.opts.folder || ".", dbName + ".db")),
        this.logger.debug(`[${this.name}] Database file:`, filename),
        makeDirs(path.dirname(filename));
      try {
        await fs.access(filename);
      } catch (err) {
        shouldCreateTables = true;
      }
    }
    if (
      (this.opts.persistent || (shouldCreateTables = true),
      this.logger.debug(`[${this.name}] Connecting to '${dbName}' DB...`),
      await new Promise((resolve, reject) => {
        db = new sqlite3.Database(
          this.opts.persistent ? filename : ":memory:",
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      }),
      this.logger.debug(
        `[${this.name}] Connected to '${dbName}' DB successfully.`
      ),
      shouldCreateTables)
    ) {
      this.logger.debug(`[${this.name}] Creating tables...`);
      const sql = this.createTablesSQL();
      sql &&
        (await new Promise((resolve, reject) => {
          db.exec(sql, (err) => {
            if (err) return reject(err);
            resolve();
          });
        }));
    }
    (this.db = db),
      db.on("error", (err) => {
        this.logger.error("DB error", err);
      }),
      this.cleanTimer && clearInterval(this.cleanTimer),
      (this.cleanTimer = setInterval(() => this.cleanup(), 6e4)),
      this.queueTimer && clearInterval(this.queueTimer),
      (this.queueTimer = setInterval(() => this.queueTick(), 1e3)),
      await this.ready();
  }
  async ready() {}
  async close() {
    if (
      (this.queueTimer && clearInterval(this.queueTimer),
      this.cleanTimer && clearInterval(this.cleanTimer),
      this.db)
    )
      return (
        this.logger.debug(`[${this.name}] Closing DB...`),
        new Promise((resolve) => {
          this.db.close((err) => {
            err && this.logger.warn("Unable to close DB", err),
              (this.db = null),
              resolve();
          });
        })
      );
  }
  async getOne(sql, params) {
    if (this.db)
      return new Promise((resolve, reject) => {
        this.db.get(sql, params, (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });
  }
  async all(sql, params) {
    if (this.db)
      return new Promise((resolve, reject) => {
        this.db.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        });
      });
  }
  async run(sql, params) {
    if (this.db)
      return new Promise((resolve, reject) => {
        this.db.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve(this.changes);
        });
      });
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      stmt: stmt,
      finalize: () =>
        new Promise((resolve, reject) => {
          stmt.finalize(function (err) {
            if (err) return reject(err);
            resolve();
          });
        }),
      run: (params) =>
        new Promise((resolve, reject) => {
          stmt.run(params, function (err) {
            if (err) return reject(err);
            resolve(this.changes);
          });
        }),
      getOne: (params) =>
        new Promise((resolve, reject) => {
          stmt.get(params, function (err, row) {
            if (err) return reject(err);
            resolve(row);
          });
        }),
      all: (params) =>
        new Promise((resolve, reject) => {
          stmt.all(params, function (err, rows) {
            if (err) return reject(err);
            resolve(rows);
          });
        }),
    };
  }
  cleanup() {}
  async queueTick() {
    if (this.db && !this.processing && 0 != this.queue.length) {
      this.processing = true;
      try {
        const items = this.queue.splice(0, 100);
        this.logger.debug(
          `[${this.name}] Processing ${items.length} from queue (remaining: ${this.queue.length})...`
        ),
          await this.Promise.mapSeries(items, async (item) => {
            try {
              await this.process(item);
            } catch (err) {
              this.logger.error("Unable to process item from queue", err);
            }
          });
      } finally {
        this.processing = false;
      }
    }
  }
  addToQueue(item) {
    this.logger.debug(
      `[${this.name}] Add item to the queue (queue length: ${this.queue.length})`
    ),
      this.queue.push(item);
  }
  async process() {}
};
const _$6 = require$$0__default$1.default,
  AbstractStore$2 = abstractStore;
var metricsStore = class extends AbstractStore$2 {
  constructor(service, opts) {
    super(service, opts),
      (this.opts = _$6.defaultsDeep(this.opts, {
        metrics: { retentionMins: 30, timeWindow: 10 },
      })),
      (this.name = "MetricStore"),
      (this.statements = {});
  }
  getDBName() {
    return "metrics";
  }
  createTablesSQL() {
    return "\n			CREATE TABLE meta (\n				key TEXT PRIMARY KEY,\n				value TEXT\n			);\n			INSERT INTO meta (key, value) VALUES ('version', '1');\n\n			CREATE TABLE metrics (\n				name TEXT PRIMARY KEY,\n				json TEXT NOT NULL\n			);\n\n			CREATE TABLE current (\n				metric TEXT NOT NULL,\n				nodeID TEXT NOT NULL,\n				key TEXT NOT NULL,\n				timestamp INTEGER NOT NULL,\n\n				service TEXT,\n				action TEXT,\n				event TEXT,\n				'group' TEXT,\n				caller TEXT,\n\n				labels TEXT,\n\n				value REAL,\n				rate REAL,\n				count INTEGER,\n				sum REAL,\n				min REAL,\n				mean REAL,\n				max REAL,\n				q50 REAL,\n				q90 REAL,\n				q95 REAL,\n				q99 REAL,\n\n				PRIMARY KEY (metric, nodeID, key)\n			);\n\n			CREATE INDEX current_idx_nodeID ON current(nodeID);\n			CREATE INDEX current_idx_metric_nodeID ON current(metric, nodeID);\n			CREATE INDEX current_idx_timestamp ON current(timestamp, nodeID);\n\n			CREATE TABLE history (\n				id INTEGER PRIMARY KEY AUTOINCREMENT,\n				metric TEXT NOT NULL,\n				key TEXT NOT NULL,\n				nodeID TEXT NOT NULL,\n				timestamp INTEGER NOT NULL,\n\n				service TEXT,\n				action TEXT,\n				event TEXT,\n				'group' TEXT,\n				caller TEXT,\n\n				labels TEXT,\n\n				value REAL,\n				rate REAL,\n				count INTEGER,\n				sum REAL,\n				min REAL,\n				mean REAL,\n				max REAL,\n				q50 REAL,\n				q90 REAL,\n				q95 REAL,\n				q99 REAL\n			);\n\n			CREATE INDEX history_idx_metric_timestamp ON history(metric, timestamp);\n			CREATE INDEX history_idx_timestamp ON history(timestamp);\n		";
  }
  ready() {
    (this.statements.addMetric = this.prepare(
      "\n			INSERT INTO metrics\n				(name, json)\n			VALUES\n				($name, $json)\n		"
    )),
      (this.statements.addGaugeHistory = this.prepare(
        "\n			INSERT INTO history\n				(metric, key, nodeID, timestamp, service, action, event, 'group', caller, labels, value, rate)\n			VALUES\n				($metric, $key, $nodeID, $timestamp, $service, $action, $event, $group, $caller, $labels, $value, $rate)\n		"
      )),
      (this.statements.addHistogramHistory = this.prepare(
        "\n			INSERT INTO history\n				(metric, key, nodeID, timestamp, service, action, event, 'group', caller, labels, rate, count, sum, min, mean, max, q50, q90, q95, q99)\n			VALUES\n				($metric, $key, $nodeID, $timestamp, $service, $action, $event, $group, $caller, $labels, $rate, $count, $sum, $min, $mean, $max, $q50, $q90, $q95, $q99)\n		"
      )),
      (this.statements.upsertGaugeCurrent = this.prepare(
        "\n			INSERT INTO current\n				(metric, key, nodeID, timestamp, service, action, event, 'group', caller, labels, value, rate)\n			VALUES\n				($metric, $key, $nodeID, $timestamp, $service, $action, $event, $group, $caller, $labels, $value, $rate)\n				ON CONFLICT(metric, nodeID, key) DO\n			UPDATE SET\n				timestamp = $timestamp, value = $value, rate = $rate\n		"
      )),
      (this.statements.upsertHistogramCurrent = this.prepare(
        "\n			INSERT INTO current\n				(metric, key, nodeID, timestamp, service, action, event, 'group', caller, labels, rate, count, sum, min, mean, max, q50, q90, q95, q99)\n			VALUES\n				($metric, $key, $nodeID, $timestamp, $service, $action, $event, $group, $caller, $labels, $rate, $count, $sum, $min, $mean, $max, $q50, $q90, $q95, $q99)\n			ON CONFLICT(metric, nodeID, key) DO\n			UPDATE SET\n				timestamp = $timestamp,\n				rate = $rate,\n				count = $count,\n				min = $min,\n				mean = $mean,\n				max = $max,\n				q50 = $q50,\n				q90 = $q90,\n				q95 = $q95,\n				q99 = $q99\n		"
      )),
      (this.statements.selectMetricByName = this.prepare(
        "SELECT json FROM metrics WHERE name = ?"
      )),
      (this.statements.selectLastValueByNameAndNodeID = this.prepare(
        "SELECT * FROM current WHERE metric = ? AND nodeID = ? ORDER BY timestamp DESC LIMIT 1"
      ));
  }
  async close() {
    try {
      await Promise.all(
        Object.values(this.statements).map((stmt) => stmt.finalize())
      );
    } catch (err) {
      this.logger.debug(`[${this.name}] Unable to finalize statements`);
    }
    await super.close();
  }
  roundToTimeWindow(ts, window = this.opts.metrics.timeWindow) {
    const d = 1e3 * window;
    return Math.floor(ts / d) * d;
  }
  async process({ nodeID: nodeID, rows: rows }) {
    if (!this.db) return;
    const startTime = Date.now();
    this.logger.debug(
      `[${this.name}] Processing item from '${nodeID}' node...`
    ),
      await this.run("BEGIN TRANSACTION");
    try {
      const registeredMetricNames = (
        await this.all("SELECT name FROM metrics")
      ).map((row) => row.name);
      await this.Promise.mapSeries(rows, async (row) => {
        try {
          const name = row.name;
          -1 == registeredMetricNames.indexOf(name) &&
            (await this.statements.addMetric.run({
              $name: name,
              $json: JSON.stringify(_$6.omit(row, ["values"])),
            })),
            await Promise.mapSeries(
              Array.from(row.values.values()),
              async (valueRow) => {
                const ts = this.roundToTimeWindow(valueRow.timestamp),
                  params = {
                    $metric: name,
                    $key: valueRow.key,
                    $nodeID: nodeID,
                    $timestamp: ts,
                    $service: valueRow.labels.service,
                    $action: valueRow.labels.action,
                    $caller: valueRow.labels.caller,
                    $event: valueRow.labels.event,
                    $group: valueRow.labels.group,
                    $labels: JSON.stringify(valueRow.labels),
                  };
                "histogram" == row.type
                  ? ((params.$rate = valueRow.rate),
                    (params.$count = valueRow.count),
                    (params.$sum = valueRow.sum),
                    (params.$min = valueRow.min),
                    (params.$mean = valueRow.mean),
                    (params.$max = valueRow.max),
                    valueRow.quantiles &&
                      ((params.$q50 = valueRow.quantiles[0.5]),
                      (params.$q90 = valueRow.quantiles[0.9]),
                      (params.$q95 = valueRow.quantiles[0.95]),
                      (params.$q99 = valueRow.quantiles[0.99])),
                    await this.statements.addHistogramHistory.run(params),
                    await this.statements.upsertHistogramCurrent.run(params))
                  : ((params.$value = valueRow.value),
                    (params.$rate = valueRow.rate),
                    await this.statements.addGaugeHistory.run(params),
                    await this.statements.upsertGaugeCurrent.run(params));
              }
            );
        } catch (err) {
          this.logger.warn(`[${this.name}] Unable to save metric`, row, err);
        }
      }),
        await this.run("COMMIT");
    } catch (err) {
      await this.run("ROLLBACK"),
        this.logger.error(`[${this.name}] Rollback transaction`, err);
    }
    this.logger.debug(
      `[${this.name}] Processed ${rows.length} metrics in ${
        Date.now() - startTime
      }ms. Queue size: ${this.queue.length}. NodeID: ${nodeID}`
    ),
      this.emitChanged();
  }
  async cleanup() {
    if (!this.db) return;
    const startTime = Date.now(),
      limitTs = Date.now() - 60 * this.opts.metrics.retentionMins * 1e3;
    this.logger.debug(`[${this.name}] Cleaning up database...`, {
      limitTs: limitTs,
    });
    try {
      const deletedHistory = await this.run(
          "DELETE FROM history WHERE timestamp < ?",
          [limitTs]
        ),
        allNodeIDs = await this.all("SELECT DISTINCT nodeID FROM current"),
        availableNodes = this.service.broker.registry.nodes
          .toArray()
          .filter((node) => node.available)
          .map((node) => node.id),
        removableNodeIDs = allNodeIDs
          .map((row) => row.nodeID)
          .filter((nodeID) => -1 == availableNodes.indexOf(nodeID));
      let deletedCurrent = 0;
      removableNodeIDs.length > 0 &&
        (deletedCurrent = await this.run(
          `\n\t\t\t\t\tDELETE FROM\n\t\t\t\t\t\tcurrent\n\t\t\t\t\tWHERE\n\t\t\t\t\t\t\ttimestamp < ${limitTs}\n\t\t\t\t\t\tAND\n\t\t\t\t\t\t\tnodeID IN (${removableNodeIDs
            .map((s) => "'" + s + "'")
            .join(",")})\n\t\t\t\t`,
          []
        )),
        this.logger.debug(
          `[${
            this.name
          }] Cleanup: Removed ${deletedHistory} old metrics history and ${deletedCurrent} old metrics current value. Time: ${
            Date.now() - startTime
          }ms`
        ),
        (deletedHistory > 0 || deletedCurrent > 0) && this.emitChanged();
    } catch (err) {
      this.logger.error(
        `[${this.name}] Error occured during cleaning database`,
        err
      );
    }
  }
  async getMetricByName(name) {
    if (!this.db) return null;
    const startTime = Date.now(),
      row = await this.statements.selectMetricByName.getOne([name]);
    if (row && row.json)
      try {
        const res = JSON.parse(row.json);
        return (
          this.logger.debug(
            `[${this.name}] 'getMetricByName' executed in ${
              Date.now() - startTime
            }ms`
          ),
          res
        );
      } catch (err) {}
    return null;
  }
  async getLastValue({ metric: metric, nodeID: nodeID, prop: prop = "value" }) {
    if (!this.db) return;
    const startTime = Date.now(),
      row = await this.statements.selectLastValueByNameAndNodeID.getOne([
        metric,
        nodeID,
      ]);
    return row
      ? (this.logger.debug(
          `[${this.name}] 'getLastValue' executed in ${
            Date.now() - startTime
          }ms`
        ),
        {
          metric: row.metric,
          nodeID: row.nodeID,
          timestamp: row.timestamp,
          value: row[prop],
        })
      : null;
  }
  async aggregate({
    metric: metric,
    groupBy: groupBy,
    prop: prop = "value",
    aggFn: aggFn = "sum",
    maxAge: maxAge,
  }) {
    const startTime = Date.now();
    if (!(await this.getMetricByName(metric))) return;
    let groupByFields,
      where = "metric = ?",
      params = [metric];
    if (null != maxAge) {
      const minTS = this.roundToTimeWindow(Date.now() - 60 * maxAge * 1e3);
      (where += " AND timestamp >= ?"), params.push(minTS);
    }
    groupBy &&
      (groupByFields = (groupBy = Array.isArray(groupBy) ? groupBy : [groupBy])
        .map((s) => "`" + s + "`")
        .join(", "));
    const sql = `\n\t\t\tSELECT\n\t\t\t\t${aggFn}(${prop}) as value\n\t\t\t\t${
      groupByFields ? ", " + groupByFields : ""
    }\n\t\t\tFROM current\n\t\t\t${where ? "WHERE " + where : ""}\n\t\t\t${
      groupByFields ? "GROUP BY " + groupByFields : ""
    }\n\t\t`;
    this.logger.debug(`[${this.name}] Aggregate SQL`, {
      sql: sql,
      params: params,
    });
    const rows = await this.all(sql, params);
    return (
      this.logger.debug(
        `[${this.name}] 'aggregate' executed in ${Date.now() - startTime}ms`
      ),
      rows
    );
  }
  async aggregateHistory({
    metric: metric,
    nodeID: nodeID,
    labels: labels,
    prop: prop,
    count: count,
    aggFn: aggFn = "sum",
  }) {
    const startTime = Date.now();
    if (!(await this.getMetricByName(metric))) return;
    const minTS = count
      ? this.roundToTimeWindow(
          Date.now() - count * this.opts.metrics.timeWindow * 1e3
        )
      : null;
    let where = "metric = ? AND timestamp >= ?",
      params = [metric, minTS];
    null != nodeID && ((where += " AND nodeID = ?"), params.push(nodeID)),
      labels &&
        Array.from(Object.entries(labels)).forEach(([key, value]) => {
          (where += " AND `" + key + "` = ?"), params.push(value);
        });
    const sql = `\n\t\tSELECT\n\t\t\ttimestamp,\n\t\t\t${aggFn}(${prop}) as value\n\t\tFROM history\n\t\t${
      where ? "WHERE " + where : ""
    }\n\t\tGROUP BY timestamp\n\t\t`;
    this.logger.debug(`[${this.name}] AggregateHistory SQL:`, {
      sql: sql,
      params: params,
    });
    const rows = await this.all(sql, params);
    return (
      this.logger.debug(
        `[${this.name}] 'aggregateHistory' executed in ${
          Date.now() - startTime
        }ms`
      ),
      rows
    );
  }
  emitChanged() {}
};
const _$5 = require$$0__default$1.default,
  AbstractStore$1 = abstractStore;
var traceStore = class extends AbstractStore$1 {
  constructor(service, opts) {
    super(service, opts),
      (this.opts = _$5.defaultsDeep(this.opts, {
        tracing: { retentionMins: 30 },
      })),
      (this.name = "TraceStore"),
      (this.statements = {});
  }
  getDBName() {
    return "traces";
  }
  createTablesSQL() {
    return "\n			CREATE TABLE meta (\n				key TEXT PRIMARY KEY,\n				value TEXT\n			);\n			INSERT INTO meta (key, value) VALUES ('version', '1');\n\n			CREATE TABLE traces (\n				id TEXT PRIMARY KEY,\n				name TEXT,\n				startTime INTEGER,\n				mainSpan TEXT,\n				spanCount INTEGER,\n				duration REAL,\n				depth INTEGER,\n				services TEXT,\n				error TEXT\n			);\n			CREATE INDEX traces_idx_startTime ON traces(startTime);\n			CREATE INDEX traces_idx_name ON traces(name);\n\n			CREATE TABLE spans (\n				id TEXT PRIMARY KEY,\n				traceID TEXT NOT NULL,\n				name TEXT,\n				startTime INTEGER,\n				error INTEGER,\n				json TEXT\n			);\n\n			CREATE INDEX spans_idx_startTime ON spans(startTime);\n			CREATE INDEX spans_idx_traceID ON spans(traceID);\n		";
  }
  ready() {
    (this.statements.insertTrace = this.prepare(
      "\n			INSERT INTO traces\n				(id, name, startTime, mainSpan, spanCount, duration, depth, services, error)\n			VALUES\n				($id, $name, $startTime, $mainSpan, $spanCount, $duration, $depth, $services, $error)\n		"
    )),
      (this.statements.updateTrace = this.prepare(
        "\n			UPDATE traces\n			SET\n				name = $name,\n				startTime = $startTime,\n				mainSpan = $mainSpan,\n				spanCount = $spanCount,\n				duration = $duration,\n				depth = $depth,\n				services = $services,\n				error = $error\n			WHERE\n				id = $id\n		"
      )),
      (this.statements.insertSpan = this.prepare(
        "\n			INSERT INTO spans\n				(id, traceID, name, startTime, error, json)\n			VALUES\n				($id, $traceID, $name, $startTime, $error, $json)\n		"
      )),
      (this.statements.getLastTraces = this.prepare(
        "SELECT * FROM traces ORDER BY startTime DESC LIMIT ?"
      )),
      (this.statements.selectTraceByID = this.prepare(
        "SELECT * FROM traces WHERE id = ?"
      )),
      (this.statements.countAllTraces = this.prepare(
        "SELECT count(id) as count FROM traces"
      )),
      (this.statements.selectSpansByTraceID = this.prepare(
        "SELECT * FROM spans WHERE traceID = ?"
      ));
  }
  async close() {
    try {
      await Promise.all(
        Object.values(this.statements).map((stmt) => stmt.finalize())
      );
    } catch (err) {
      this.logger.debug(`[${this.name}] Unable to finalize statements`);
    }
    await super.close();
  }
  async process(spans) {
    if (!this.db) return;
    const startTime = Date.now();
    this.logger.debug(`[${this.name}] Processing item...`),
      await this.run("BEGIN TRANSACTION");
    try {
      await Promise.mapSeries(spans, async (span) => {
        try {
          const traceID = span.traceID,
            isMainSpan = null == span.parentID,
            serviceName = span.service
              ? span.service.fullName || span.service.name
              : null,
            depth =
              span.tags && null != span.tags.callingLevel
                ? span.tags.callingLevel
                : null;
          let trace = await this.statements.selectTraceByID.getOne([traceID]);
          if (trace) {
            const services = JSON.parse(trace.services);
            services[serviceName] = (services[serviceName] || 0) + 1;
            const params = {
              $id: traceID,
              $name: isMainSpan ? span.name : trace.name,
              $startTime: isMainSpan ? span.startTime : trace.startTime,
              $mainSpan: isMainSpan ? span.id : trace.mainSpan,
              $spanCount: trace.spanCount + 1,
              $duration: isMainSpan ? span.duration : trace.duration,
              $depth: Math.max(depth, trace.depth),
              $services: JSON.stringify(services),
              $error: isMainSpan && span.error ? span.error.name : trace.error,
            };
            trace = await this.statements.updateTrace.run(params);
          } else {
            this.logger.debug(`[${this.name}] Create new trace '${traceID}'.`);
            const params = {
              $id: traceID,
              $name: isMainSpan ? span.name : null,
              $startTime: isMainSpan ? span.startTime : null,
              $mainSpan: isMainSpan ? span.id : null,
              $spanCount: 1,
              $duration: isMainSpan ? span.duration : null,
              $depth: depth,
              $services: JSON.stringify({ [serviceName]: 1 }),
              $error: isMainSpan && span.error ? span.error.name : null,
            };
            trace = await this.statements.insertTrace.run(params);
          }
          await this.statements.insertSpan.run({
            $id: span.id,
            $traceID: span.traceID,
            $name: span.name,
            $startTime: span.startTime,
            $error: !!span.error,
            $json: JSON.stringify(span),
          });
        } catch (err) {
          this.logger.warn(
            `[${this.name}] Unable to save tracing span`,
            span,
            err
          );
        }
      }),
        await this.run("COMMIT");
    } catch (err) {
      await this.run("ROLLBACK"),
        this.logger.error(`[${this.name}] Rollback transaction`, err);
    }
    this.logger.debug(
      `[${this.name}] Processed ${spans.length} traces in ${
        Date.now() - startTime
      }ms. Queue size: ${this.queue.length}.`
    ),
      this.emitChanged();
  }
  async cleanup() {
    if (!this.db) return;
    const startTime = Date.now(),
      limitTs = Date.now() - 60 * this.opts.tracing.retentionMins * 1e3;
    this.logger.debug(`[${this.name}] Cleaning up database...`, {
      limitTs: limitTs,
    });
    try {
      const deletedTraces = await this.run(
          "DELETE FROM traces WHERE startTime < ?",
          [limitTs]
        ),
        deletedSpans = await this.run("DELETE FROM spans WHERE startTime < ?", [
          limitTs,
        ]);
      this.logger.debug(
        `[${
          this.name
        }] Cleanup: Removed ${deletedTraces} old traces and ${deletedSpans} old spans. Time: ${
          Date.now() - startTime
        }ms`
      ),
        (deletedTraces > 0 || deletedSpans > 0) && this.emitChanged();
    } catch (err) {
      this.logger.error(
        `[${this.name}] Error occured during cleaning database`,
        err
      );
    }
  }
  async getLastTraces(params) {
    const startTime = Date.now(),
      count = params.count || 100;
    let res;
    return (
      (res = params.search
        ? await this.all(
            `SELECT * FROM traces WHERE name LIKE '%${params.search}%' OR id LIKE '%${params.search}%' ORDER BY startTime DESC LIMIT ${count}`
          )
        : await this.statements.getLastTraces.all([count])),
      this.logger.debug(
        `[${this.name}] 'getLastTraces' executed in ${Date.now() - startTime}ms`
      ),
      res
    );
  }
  async getTraceDetails(id) {
    const startTime = Date.now(),
      trace = await this.statements.selectTraceByID.getOne([id]);
    if (trace) {
      const spans = await this.statements.selectSpansByTraceID.all([id]);
      spans && (trace.spans = spans.map((span) => JSON.parse(span.json)));
    }
    return (
      this.logger.debug(
        `[${this.name}] 'getTraceDetails' executed in ${
          Date.now() - startTime
        }ms`
      ),
      trace
    );
  }
  async countAllTraces() {
    const startTime = Date.now(),
      res = await this.statements.countAllTraces.getOne();
    return res
      ? (this.logger.debug(
          `[${this.name}] 'countAllTraces' executed in ${
            Date.now() - startTime
          }ms`
        ),
        res.count)
      : null;
  }
  emitChanged() {}
};
const _$4 = require$$0__default$1.default,
  AbstractStore = abstractStore;
var logStore = class extends AbstractStore {
  constructor(service, opts) {
    super(service, opts),
      (this.opts = _$4.defaultsDeep(this.opts, {
        logging: { retentionMins: 30 },
      })),
      (this.name = "LogStore"),
      (this.statements = {});
  }
  getDBName() {
    return "logs";
  }
  createTablesSQL() {
    return "\n			CREATE TABLE meta (\n				key TEXT PRIMARY KEY,\n				value TEXT\n			);\n			INSERT INTO meta (key, value) VALUES ('version', '1');\n\n			CREATE TABLE entries (\n				id INTEGER PRIMARY KEY AUTOINCREMENT,\n				timestamp INTEGER,\n				nodeID TEXT,\n				module TEXT,\n				level TEXT,\n				message TEXT,\n				args TEXT\n			);\n			CREATE INDEX entries_idx_timestamp ON entries(timestamp);\n			CREATE INDEX entries_idx_nodeID ON entries(nodeID);\n		";
  }
  ready() {
    this.statements.insertEntry = this.prepare(
      "\n			INSERT INTO entries\n				(timestamp, nodeID, module, level, message, args)\n			VALUES\n				($timestamp, $nodeID, $module, $level, $message, $args)\n		"
    );
  }
  async close() {
    try {
      await Promise.all(
        Object.values(this.statements).map((stmt) => stmt.finalize())
      );
    } catch (err) {
      this.logger.debug(`[${this.name}] Unable to finalize statements`);
    }
    await super.close();
  }
  async process(entries) {
    if (!this.db) return;
    const startTime = Date.now();
    this.logger.debug(`[${this.name}] Processing item...`),
      await this.run("BEGIN TRANSACTION");
    try {
      await Promise.mapSeries(entries, async (entry) => {
        try {
          await this.statements.insertEntry.run({
            $timestamp: entry.ts,
            $nodeID: entry.nodeID,
            $module: entry.mod,
            $level: entry.level,
            $message: entry.message,
            $args: null,
          });
        } catch (err) {
          this.logger.warn(
            `[${this.name}] Unable to save log entry`,
            entry,
            err
          );
        }
      }),
        await this.run("COMMIT");
    } catch (err) {
      await this.run("ROLLBACK"),
        this.logger.error(`[${this.name}] Rollback transaction`, err);
    }
    this.logger.debug(
      `[${this.name}] Processed ${entries.length} entries in ${
        Date.now() - startTime
      }ms. Queue size: ${this.queue.length}.`
    ),
      this.emitChanged();
  }
  async cleanup() {
    if (!this.db) return;
    const startTime = Date.now(),
      limitTs = Date.now() - 60 * this.opts.logging.retentionMins * 1e3;
    this.logger.debug(`[${this.name}] Cleaning up database...`, {
      limitTs: limitTs,
    });
    try {
      const deletedEntries = await this.run(
        "DELETE FROM entries WHERE timestamp < ?",
        [limitTs]
      );
      this.logger.debug(
        `[${this.name}] Cleanup: Removed ${deletedEntries} old entries. Time: ${
          Date.now() - startTime
        }ms`
      ),
        deletedEntries > 0 && this.emitChanged();
    } catch (err) {
      this.logger.error(
        `[${this.name}] Error occured during cleaning database`,
        err
      );
    }
  }
  async getLastEntries(params) {
    const startTime = Date.now(),
      count = params.count || 100,
      lastID = params.lastID;
    let wheres = [];
    params.search &&
      wheres.push(
        `(\n\t\t\t\tmessage LIKE '%${params.search}%'\n\t\t\t OR nodeID = '${
          params.search
        }'\n\t\t\t OR module = '${params.search.toLowerCase()}'\n\t\t\t OR level = '${params.search.toLowerCase()}'\n\t\t\t)`
      ),
      null != lastID && wheres.push(`id > ${lastID}`);
    let sql = "SELECT * FROM entries";
    wheres.length > 0 && (sql += " WHERE " + wheres.join(" AND ")),
      (sql += ` ORDER BY timestamp DESC LIMIT ${count}`);
    const res = await this.all(sql);
    return (
      this.logger.debug(
        `[${this.name}] 'getLastEntries' executed in ${
          Date.now() - startTime
        }ms`
      ),
      res
    );
  }
  emitChanged() {}
};
const IO = require$$0__default$2.default,
  kleur = require$$1__default$1.default,
  crypto = require$$2__default$1.default,
  _$3 = require$$0__default$1.default,
  pkg = require$$4,
  zlib$3 = require$$2__default$2.default,
  { promisify: promisify$3 } = require$$3__default.default,
  { safetyObject: safetyObject$1 } = require$$0__default.default.Utils,
  MetricStore = metricsStore,
  TraceStore = traceStore,
  LogStore = logStore,
  deflate$3 = promisify$3(zlib$3.deflate),
  inflate = promisify$3(zlib$3.inflate);
let generatedToken = false;
var service = {
  name: "$lab",
  metadata: {
    $category: "lab",
    $description: "Laboratory Agent service",
    $official: true,
    $package: { name: pkg.name, version: pkg.version, repo: null },
  },
  settings: {
    $secureSettings: ["token", "apiKey"],
    name: "Moleculer Project",
    port: process.env.LAB_PORT > 0 ? process.env.LAB_PORT : 3210,
    token: process.env.LAB_TOKEN,
    apiKey: process.env.LAB_APIKEY,
  },
  events: {
    "$services.changed": {
      tracing: false,
      handler() {
        this.sendRegistryUpdatedMessage();
      },
    },
    "$node.connected": {
      tracing: false,
      handler() {
        this.sendRegistryUpdatedMessage();
      },
    },
    "$node.updated": {
      tracing: false,
      handler() {
        this.sendRegistryUpdatedMessage();
      },
    },
    "$node.disconnected": {
      tracing: false,
      handler() {
        this.sendRegistryUpdatedMessage();
      },
    },
    "$lab.metrics.changes": {
      context: true,
      tracing: false,
      async handler(ctx) {
        if (!this.metricStore) return;
        this.hasMetrics ||
          ((this.hasMetrics = true), this.projectFeaturesChanged());
        const nodeID = ctx.nodeID;
        if (!this.nodeIDList.has(nodeID))
          try {
            const metrics = await ctx.call("$node.metrics", null, {
              nodeID: nodeID,
            });
            return (
              this.nodeIDList.add(nodeID),
              void this.metricStore.addToQueue({
                nodeID: nodeID,
                rows: metrics,
              })
            );
          } catch (err) {
            this.logger.warn(`Unable to collect metrics from node '${nodeID}'`);
          }
        const data = await this.unpack(ctx.params);
        data &&
          (this.metricStore.addToQueue({ nodeID: ctx.nodeID, rows: data }),
          this.logger.debug(`Metrics info received from '${ctx.nodeID}'.`));
      },
    },
    "$lab.tracing.spans": {
      context: true,
      tracing: false,
      async handler(ctx) {
        if (!this.traceStore) return;
        this.hasTracing ||
          ((this.hasTracing = true), this.projectFeaturesChanged());
        const data = await this.unpack(ctx.params);
        data &&
          data.length > 0 &&
          (this.traceStore.addToQueue(data),
          this.logger.debug(
            `Tracing info received from '${ctx.nodeID}'. Spans: ${data.length}`
          ));
      },
    },
    "$lab.log.entries": {
      context: true,
      tracing: false,
      async handler(ctx) {
        if (!this.logStore) return;
        this.hasLogging ||
          ((this.hasLogging = true), this.projectFeaturesChanged());
        const data = await this.unpack(ctx.params);
        data &&
          data.length > 0 &&
          (this.logStore.addToQueue(data),
          this.logger.debug(
            `Log entries received from '${ctx.nodeID}'. Size: ${data.length}`
          ));
      },
    },
  },
  methods: {
    async pack(data) {
      const json = JSON.stringify(data),
        res = Buffer.from(await deflate$3(json));
      return (
        json &&
          this.logger.debug(
            "Packing data. JSON:",
            json.length,
            " Packed:",
            res.length,
            " Rate:",
            Number((res.length / json.length) * 100).toFixed(2) + "%"
          ),
        res
      );
    },
    unpack: async (data) => (
      _$3.isObject(data) &&
        "Buffer" == data.type &&
        (data = Buffer.from(data.data)),
      data instanceof ArrayBuffer || Buffer.isBuffer(data)
        ? JSON.parse(await inflate(data))
        : data
    ),
    projectFeaturesChanged() {
      return (
        this.logger.debug(
          "Project features has been changed. Sending to frontend..."
        ),
        this.sendProjectInfo()
      );
    },
    async sendProjectInfo(client) {
      const payload = {
          name: this.settings.name,
          apiKey: this.settings.apiKey,
          version: this.settings.version,
          agentVersion: pkg.version,
          moleculerVersion: this.broker.MOLECULER_VERSION,
          protocolVersion: this.broker.PROTOCOL_VERSION,
          namespace: this.broker.namespace,
          features: {
            metrics: this.hasMetrics,
            tracing: this.hasTracing,
            logging: this.hasLogging,
          },
        },
        data = await this.pack(payload);
      this.logger.debug("Sending project info to clients..."),
        client
          ? client.emit("project.info", data)
          : this.io.emit("project.info", data);
    },
    async sendBrokerOptions(client) {
      const opts = safetyObject$1(this.broker.options);
      try {
        (opts.$classNames = {}),
          this.broker.transit &&
            (opts.$classNames.transporter = this.broker.getConstructorName(
              this.broker.transit.tx
            )),
          this.broker.cacher &&
            (opts.$classNames.cacher = this.broker.getConstructorName(
              this.broker.cacher
            )),
          this.broker.serializer &&
            (opts.$classNames.serializer = this.broker.getConstructorName(
              this.broker.serializer
            )),
          this.broker.validator &&
            (opts.$classNames.validator = this.broker.getConstructorName(
              this.broker.validator
            ));
      } catch (err) {
        this.logger.debug("Unable to collect module classnames.", err);
      }
      const data = await this.pack(opts);
      client
        ? client.emit("broker.options", data)
        : this.io.emit("broker.options", data);
    },
    sendRegistryUpdatedMessage: _$3.throttle(async function () {
      this.logger.debug("Registry updated. Sending new registry to clients..."),
        this.io.emit(
          "service-registry.updated",
          await this.pack(this.getRegistryContent())
        );
    }, 2e3),
    getRegistryContent() {
      return this.broker.registry.nodes.toArray().map((node) => {
        const res = _$3.pick(node, [
          "id",
          "local",
          "available",
          "hostname",
          "ipList",
          "instanceID",
          "offlineSince",
          "lastHeartbeatTime",
        ]);
        return (res.rawInfo = this.broker.registry.getNodeInfo(res.id)), res;
      });
    },
    hashURL: (str) => Buffer.from(str).toString("base64"),
  },
  created() {
    (this.nodeIDList = new Set()),
      (this.hasMetrics = false),
      (this.hasTracing = false),
      (this.hasLogging = false),
      this.settings.token ||
        (this.logger.debug("Token is not set. Generating a random token..."),
        (generatedToken = true),
        (this.settings.token = Math.random().toString(36).substr(2, 9)));
  },
  async started() {
    this.logger.debug("Creating metric store..."),
      (this.metricStore = new MetricStore(this, this.settings.store)),
      await this.metricStore.connect(),
      this.logger.debug("Creating tracing store..."),
      (this.traceStore = new TraceStore(this, this.settings.store)),
      await this.traceStore.connect(),
      this.logger.debug("Creating logging store..."),
      (this.logStore = new LogStore(this, this.settings.store)),
      await this.logStore.connect();
    const origins = [
      "http://lab.moleculer.services",
      "https://lab.moleculer.services",
      "http://localhost:8080",
    ];
    this.logger.debug("Creating IO server..."),
      (this.io = IO(this.settings.port, {
        serveClient: false,
        origins: origins,
        allowRequest: (req, cb) => {
          let token;
          this.logger.debug("Received client handshake");
          const auth = req.headers.authorization;
          if (
            (auth && auth.startsWith("Token ") && (token = auth.slice(6)),
            token &&
              this.settings.token &&
              token.length == this.settings.token.length &&
              crypto.timingSafeEqual(
                Buffer.from(token),
                Buffer.from(this.settings.token)
              ))
          )
            return cb(null, true);
          this.logger.debug(
            "Invalid client token. Decline the connection",
            token
          ),
            cb(4, false);
        },
        handlePreflightRequest: (req, res) => {
          const origin = req.headers.origin,
            validOrigin = -1 !== origins.indexOf(origin);
          this.logger.debug("Handle CORS preflight request.", {
            origin: origin,
          }),
            res.writeHead(200, {
              "Access-Control-Allow-Headers": "Authorization",
              "Access-Control-Allow-Methods": "GET",
              "Access-Control-Allow-Origin": validOrigin
                ? req.headers.origin
                : "http://lab.moleculer.services",
              "Access-Control-Allow-Credentials": true,
            }),
            res.end();
        },
      })),
      this.io.on("connection", async (client) => {
        this.logger.debug(
          `Moleculer Lab Client connected (${client.conn.remoteAddress}).`
        ),
          client.on("disconnect", () => {
            this.logger.debug(
              `Moleculer Lab Client disconnected (${client.conn.remoteAddress}).`
            );
          }),
          await this.sendProjectInfo(client),
          await this.sendBrokerOptions(client),
          client.emit(
            "service-registry.updated",
            await this.pack(this.getRegistryContent())
          ),
          client.on(
            "callAction",
            async (actionName, params, opts, callback) => {
              try {
                this.logger.debug(`Client calls the '${actionName}' action`, {
                  actionName: actionName,
                  params: params,
                  opts: opts,
                });
                const response = await this.broker.call(
                  actionName,
                  params,
                  opts
                );
                callback && callback(null, await this.pack(response));
              } catch (err) {
                const res = { ...err };
                (res.name = err.name),
                  (res.message = err.message),
                  (res.stack = err.stack),
                  callback && callback(res);
              }
            }
          ),
          client.on("emitEvent", async (eventName, params, opts, callback) => {
            try {
              this.logger.debug(`Client emits the '${eventName}' event`, {
                eventName: eventName,
                params: params,
                opts: opts,
              }),
                await this.broker.emit(eventName, params, opts),
                callback && callback(null, true);
            } catch (err) {
              const res = { ...err };
              (res.name = err.name),
                (res.message = err.message),
                (res.stack = err.stack),
                callback && callback(res);
            }
          }),
          client.on(
            "broadcastEvent",
            async (eventName, params, opts, callback) => {
              try {
                this.logger.debug(
                  `Client broadcasts the '${eventName}' event`,
                  { eventName: eventName, params: params, opts: opts }
                ),
                  await this.broker.broadcast(eventName, params, opts),
                  callback && callback(null, true);
              } catch (err) {
                const res = { ...err };
                (res.name = err.name),
                  (res.message = err.message),
                  (res.stack = err.stack),
                  callback && callback(res);
              }
            }
          ),
          client.on("metrics:getLastValue", async (params, callback) => {
            try {
              let res;
              this.logger.debug("Client requests data from metric store", {
                method: "getLastValue",
                params: params,
              }),
                (res = Array.isArray(params)
                  ? await Promise.all(
                      params.map((p) => this.metricStore.getLastValue(p))
                    )
                  : await this.metricStore.getLastValue(params)),
                callback && callback(null, await this.pack(res));
            } catch (err) {
              const res = { ...err };
              (res.name = err.name),
                (res.message = err.message),
                (res.stack = err.stack),
                callback && callback(res);
            }
          }),
          client.on("metrics:aggregate", async (params, callback) => {
            try {
              let res;
              this.logger.debug("Client requests data from metric store", {
                method: "aggregate",
                params: params,
              }),
                (res = Array.isArray(params)
                  ? await Promise.all(
                      params.map((p) => this.metricStore.aggregate(p))
                    )
                  : await this.metricStore.aggregate(params)),
                callback && callback(null, await this.pack(res));
            } catch (err) {
              const res = { ...err };
              (res.name = err.name),
                (res.message = err.message),
                (res.stack = err.stack),
                callback && callback(res);
            }
          }),
          client.on("metrics:aggregateHistory", async (params, callback) => {
            try {
              let res;
              this.logger.debug("Client requests data from metric store", {
                method: "aggregateHistory",
                params: params,
              }),
                (res = Array.isArray(params)
                  ? await Promise.all(
                      params.map((p) => this.metricStore.aggregateHistory(p))
                    )
                  : await this.metricStore.aggregateHistory(params)),
                callback && callback(null, await this.pack(res));
            } catch (err) {
              const res = { ...err };
              (res.name = err.name),
                (res.message = err.message),
                (res.stack = err.stack),
                callback && callback(res);
            }
          }),
          client.on("traces:getLastTraces", async (params, callback) => {
            try {
              this.logger.debug("Client requests data from tracing store", {
                method: "getLastTraces",
                params: params,
              });
              const res = {
                traces: await this.traceStore.getLastTraces(params),
                count: await this.traceStore.countAllTraces(),
              };
              callback && callback(null, await this.pack(res));
            } catch (err) {
              const res = { ...err };
              (res.name = err.name),
                (res.message = err.message),
                (res.stack = err.stack),
                callback && callback(res);
            }
          }),
          client.on("traces:getTraceDetails", async (params, callback) => {
            try {
              this.logger.debug("Client requests data from tracing store", {
                method: "getTraceDetails",
                params: params,
              });
              const res = await this.traceStore.getTraceDetails(params.id);
              callback && callback(null, await this.pack(res));
            } catch (err) {
              const res = { ...err };
              (res.name = err.name),
                (res.message = err.message),
                (res.stack = err.stack),
                callback && callback(res);
            }
          }),
          client.on("logs:getLastEntries", async (params, callback) => {
            try {
              this.logger.debug("Client requests data from log store", {
                method: "getLastEntries",
                params: params,
              });
              const res = await this.logStore.getLastEntries(params);
              callback && callback(null, await this.pack(res));
            } catch (err) {
              const res = { ...err };
              (res.name = err.name),
                (res.message = err.message),
                (res.stack = err.stack),
                callback && callback(res);
            }
          });
      });
    const accessURL = `https://lab.moleculer.services/project/${this.hashURL(
      "http://localhost:" + this.settings.port
    )}`;
    setTimeout(() => {
      this.logger.info(
        "***********************************************************"
      ),
        this.logger.info(""),
        this.logger.info("  ✔ Moleculer Laboratory service started."),
        this.logger.info(""),
        this.logger.info(
          `  Token: ${kleur.grey(
            "(" + (generatedToken ? "generated" : "static") + ")"
          )}`
        ),
        this.logger.info(`      ${kleur.bold().yellow(this.settings.token)}`),
        this.logger.info(""),
        this.logger.info("  Agent running on:"),
        this.logger.info(
          `      ${kleur.cyan("http://localhost:" + this.settings.port)}`
        ),
        this.logger.info(""),
        this.logger.info("  Open Laboratory:"),
        this.logger.info(`      ${kleur.cyan(accessURL)}`),
        this.logger.info(""),
        this.logger.info(
          "***********************************************************"
        );
    }, 1e3);
  },
  async stopped() {
    this.io && this.io.close(),
      this.metricStore &&
        (await this.metricStore.close(), (this.metricStore = null)),
      this.traceStore &&
        (await this.traceStore.close(), (this.traceStore = null)),
      this.logStore && (await this.logStore.close(), (this.logStore = null));
  },
};
var src = {
  AgentService: service,
};
module.exports = src;
