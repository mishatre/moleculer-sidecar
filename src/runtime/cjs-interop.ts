/**
 * Named exports of CommonJS dependencies, reached through their default export.
 *
 * Why: inside the packaged binary, Node's CommonJS named-export detection only
 * reports the **first** key of a dependency's `module.exports` object (verified —
 * `import { ServiceBroker } from 'moleculer'` resolves while
 * `import { Errors } from 'moleculer'` throws "Named export not found", even
 * though the file in the archive is byte-complete). Importing the namespace as a
 * default export and destructuring at runtime always works, in every module
 * system and in a plain `node` run.
 *
 * Everything else imports normally: `moldecor` (dual ESM/CJS), `zod`, `yaml` and
 * `is-stream` ship real ES modules, and the remaining CommonJS packages are only
 * ever used through their default export.
 */

import type { ServiceBroker as MoleculerServiceBroker } from 'moleculer';
import moleculer from 'moleculer';
import typeIs from 'type-is';

const { Errors, Service, ServiceBroker } = moleculer;
const { is } = typeIs;

// The *type* meaning of the class, re-declared locally: `moleculer` types
// `ServiceBroker` as a generic class, so consumers can keep annotating with it
// (`broker: ServiceBroker`). A type alias may share its name with the value — the
// two live in separate declaration spaces — and the import above is type-only, so
// nothing here is a named import at runtime, which is the problem this module
// solves.
type ServiceBroker = MoleculerServiceBroker;

// `Errors` is the one name this module cannot carry on its own: in `moleculer` it
// is a *namespace* of error classes (value + type), and a namespace has no type
// alias to re-declare. Consumers that need it in a type position
// (`error is Errors.MoleculerError`) register `import type { Errors } from
// 'moleculer'` themselves, under whatever local name keeps the two apart.
export { Errors, is, Service, ServiceBroker };
