export function getRootDir() {
    return process.cwd();
}

export function isPlainObject(o: any): o is Object {
    return o != null
        ? Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null
        : false;
}

export function dotSet<T extends { [key: string]: any }, K extends keyof T>(
    obj: T,
    path: K,
    value: T[K],
) {
    const parts = (path as string).split('.');
    const part = parts.shift()! as K;
    if (parts.length > 0) {
        if (!Object.prototype.hasOwnProperty.call(obj, part)) {
            obj[part] = {};
        } else if (obj[part] == null) {
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
