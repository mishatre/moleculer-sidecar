import { GenericObject } from 'moleculer';

export function getRootDir() {
    return process.cwd();
}

export function isPlainObject(o: any): o is Object {
    return o != null
        ? Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null
        : false;
}

/**
 * Sets a variable on an object based on its dot path.
 *
 * @param {Object} obj
 * @param {String} path
 * @param {*} value
 * @returns {Object}
 */
export function dotSet(obj: GenericObject, path: string, value: unknown) {
    const parts = path.split('.');
    const part = parts.shift()!;
    if (parts.length > 0) {
        if (!Object.prototype.hasOwnProperty.call(obj, part)) {
            obj[part] = {};
        } else if (obj[part!] == null) {
            obj[part] = {};
        } else {
            if (typeof obj[part] !== 'object') {
                throw new Error("Value already set and it's not an object");
            }
        }
        obj[part] = dotSet(obj[part], parts.join('.'), value);
        return obj;
    }
    obj[path] = value;
    return obj;
}

export function normalizeEnvValue(value: unknown) {
    if (
        typeof value === 'string' &&
        (value.toLowerCase() === 'true' || value.toLowerCase() === 'false')
    ) {
        // Convert to boolean
        return value === 'true';
    } else if (!isNaN(value as number)) {
        // Convert to number
        return Number(value);
    }
    return value;
}

export function resolveFilePath(filePath: string) {
    try {
        return import.meta.resolve(filePath);
    } catch (error) {
        console.log(error);
    }
    try {
        return require.resolve(filePath);
    } catch (_) {}
    return null;
}
