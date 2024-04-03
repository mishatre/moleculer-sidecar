import { BrokerOptions } from 'moleculer';

import { dotSet, isPlainObject } from './index.js';

function normalizeEnvValue(value: any): value is boolean | number | string {
    if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
        // Convert to boolean
        value = value === 'true';
    } else if (!isNaN(value)) {
        // Convert to number
        value = Number(value);
    }
    return value;
}

export function overwriteFromEnv<T extends { [key: string]: any }, K extends keyof T>(
    obj: T,
    prefix?: string,
) {
    for (const key in obj as BrokerOptions) {
        const envName = ((prefix ? prefix + '_' : '') + key).toUpperCase();

        if (process.env[envName]) {
            obj[key as keyof T] = normalizeEnvValue(process.env[envName]);
        }

        if (isPlainObject(obj[key as keyof T])) {
            obj[key as keyof T] = overwriteFromEnv(
                obj[key as keyof T],
                (prefix ? prefix + '_' : '') + key,
            );
        }
    }

    // Process MOL_ env vars only the root level
    if (prefix == null) {
        const moleculerPrefix = 'MOL_';
        const moleculerEnvVars = Object.keys(process.env)
            .filter((key) => key.startsWith(moleculerPrefix))
            .map((key) => ({
                key,
                withoutPrefix: key.substring(moleculerPrefix.length),
            }));
        for (const variable of moleculerEnvVars) {
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
            obj = dotSet<T, K>(obj, dotted, normalizeEnvValue(process.env[variable.key]));
        }
    }

    return obj;
}
