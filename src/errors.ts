import type { Errors as ErrorsType } from 'moleculer';
import xml2js from 'xml2js';
import { Errors } from './runtime/cjs-interop.js';

const { parseStringPromise } = xml2js;

export const ERR_NO_TOKEN = 'NO_TOKEN';
export const ERR_INVALID_TOKEN = 'INVALID_TOKEN';

/**
 * Not found HTTP error
 *
 * @class NotFoundError
 * @extends {Error}
 */
export class MethodNotAllowed extends Errors.MoleculerError {
    /**
     * Creates an instance of NotFoundError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf NotFoundError
     */
    constructor(type?: string, data?: unknown) {
        super('Method not allowed', 405, type || 'METHOD_NOT_ALLOWED', data);
    }
}

/**
 * Not found HTTP error
 *
 * @class NotFoundError
 * @extends {Error}
 */
export class NotFoundError extends Errors.MoleculerError {
    /**
     * Creates an instance of NotFoundError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf NotFoundError
     */
    constructor(type?: string, data?: unknown) {
        super('Not found', 404, type || 'NOT_FOUND', data);
    }
}

/**
 * Not found HTTP error
 *
 * @class NotFoundError
 * @extends {Error}
 */
export class UnsupportedMediaType extends Errors.MoleculerError {
    /**
     * Creates an instance of NotFoundError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf NotFoundError
     */
    constructor(type?: string, data?: unknown) {
        super('Unsupported media type', 415, type || 'UNSUPPORTED_MEDIA_TYPE', data);
    }
}

/**
 * Unauthorized HTTP error
 *
 * @class UnAuthorizedError
 * @extends {Error}
 */
export class UnAuthorizedError extends Errors.MoleculerError {
    /**
     * Creates an instance of UnAuthorizedError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf UnAuthorizedError
     */
    constructor(type: string, data?: unknown) {
        super('Unauthorized', 401, type || ERR_INVALID_TOKEN, data);
    }
}

/**
 * Forbidden HTTP error
 *
 * @class ForbiddenError
 * @extends {Error}
 */
export class ForbiddenError extends Errors.MoleculerError {
    /**
     * Creates an instance of ForbiddenError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf ForbiddenError
     */
    constructor(type?: string, data?: unknown) {
        super('Forbidden', 403, type || 'FORBIDDEN', data);
    }
}

/**
 * Service unavailable HTTP error
 *
 * @class ForbiddenError
 * @extends {Error}
 */
export class ServiceUnavailableError extends Errors.MoleculerError {
    /**
     * Creates an instance of ForbiddenError.
     *
     * @param {String} type
     * @param {any} data
     *
     * @memberOf ForbiddenError
     */
    constructor(type = '', data?: unknown) {
        super('Service unavailable', 503, type, data);
    }
}

/**
 * 'Request timed out' Error message. Retryable.
 *
 * @class RequestTimeoutError
 * @extends {MoleculerRetryableError}
 */
export class RequestTimeoutError extends Errors.MoleculerRetryableError {
    /**
     * Creates an instance of RequestTimeoutError.
     *
     * @param {Object} data
     *
     * @memberof RequestTimeoutError
     */
    constructor(target: any, data?: any) {
        super(`Request is timed out when calling '${target}'.`, 504, 'REQUEST_TIMEOUT', data);
    }
}

/**
 * 'Request rejected' Error message. Retryable.
 *
 * @class RequestRejectedError
 * @extends {MoleculerRetryableError}
 */
export class RequestRejectedError extends Errors.MoleculerRetryableError {
    /**
     * Creates an instance of RequestRejectedError.
     *
     * @param {Object} data
     *
     * @memberof RequestRejectedError
     */
    constructor(target: any, data?: any) {
        super(`Request is rejected when calling '${target}'.`, 503, 'REQUEST_REJECTED', data);
    }
}

export function isMoleculerError(error: unknown): error is ErrorsType.MoleculerError {
    return error instanceof Errors.MoleculerError;
}

export function convertToMoleculerError(error: unknown): ErrorsType.MoleculerError {
    if (!(error instanceof Errors.MoleculerError)) {
        const e = error as ErrorsType.MoleculerError;
        const err = new Errors.MoleculerError(
            e.message,
            e.code || (e as any).status,
            e.type,
            e.data,
        );
        err.name = e.name;
        err.stack = e.stack;
        return err;
    }
    return error;
}

export async function convert1CErrorToMoleculerError(response: Response, errorText: string) {
    const xmlData = await parseStringPromise(errorText);
    const errorDescription = xmlData.exception.descr[0]._;
    const errorStack = xmlData.exception.creationStack[0]._;
    const error = new Errors.MoleculerError(errorDescription, response.status, response.statusText);
    error.stack = errorStack;

    return error;
}
