import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ForbiddenError, UnAuthorizedError } from '../errors.js';
import type { IncomingMessage, ServerResponse } from '../types.js';

export const SESSION_COOKIE = 'sidecar_ui';
export const CSRF_HEADER = 'x-ui-csrf';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const ALGORITHM = 'scrypt';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const COOKIE_PATH = '/ui';
const API_PATH = '/api';
const LOGIN_PATH = '/api/login';
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface UiAuth {
    passwordHash: string;
    sessionSecret: string;
    ttlMs: number;
}

/**
 * Builds the auth config from the environment and refuses a weak setup, so the
 * ui service can only start when it is actually guarded.
 */
export function resolveUiAuth(env: NodeJS.ProcessEnv = process.env): UiAuth {
    const passwordHash = (env.UI_PASSWORD_HASH ?? '').trim();
    const sessionSecret = (env.UI_SESSION_SECRET ?? '').trim();

    if (!isPasswordHash(passwordHash)) {
        throw new Error(
            'ui: UI_PASSWORD_HASH must look like "scrypt$<salt>$<hash>" (generate one with `pnpm ui:password`)',
        );
    }
    if (sessionSecret.length < 32) {
        throw new Error('ui: UI_SESSION_SECRET must be at least 32 characters long');
    }

    return { passwordHash, sessionSecret, ttlMs: SESSION_TTL_MS };
}

export function isPasswordHash(value: string): boolean {
    const [algorithm, salt, hash] = value.split('$');
    return algorithm === ALGORITHM && isHex(salt) && isHex(hash);
}

export function hashPassword(password: string): string {
    const salt = randomBytes(SALT_LENGTH);
    return [
        ALGORITHM,
        salt.toString('hex'),
        scryptSync(password, salt, KEY_LENGTH).toString('hex'),
    ].join('$');
}

export function verifyPassword(password: string, passwordHash: string): boolean {
    const [, salt, hash] = passwordHash.split('$');
    if (!isHex(salt) || !isHex(hash)) {
        return false;
    }

    const expected = Buffer.from(hash, 'hex');
    return safeEqual(expected, scryptSync(password, Buffer.from(salt, 'hex'), expected.length));
}

export function createSession(
    secret: string,
    ttlMs: number,
    now = Date.now(),
): { value: string; expiresAt: number } {
    const expiresAt = now + ttlMs;
    return { value: `${expiresAt}.${mac(secret, `session:${expiresAt}`)}`, expiresAt };
}

export function verifySession(
    value: string | undefined,
    secret: string,
    now = Date.now(),
): boolean {
    const [expiresAt, signature] = (value ?? '').split('.');
    if (!expiresAt || !signature || Number(expiresAt) <= now) {
        return false;
    }

    return safeEqual(Buffer.from(signature), Buffer.from(mac(secret, `session:${expiresAt}`)));
}

export function csrfToken(sessionValue: string, secret: string): string {
    return mac(secret, `csrf:${sessionValue}`);
}

export function verifyCsrf(
    sessionValue: string,
    secret: string,
    token: string | undefined,
): boolean {
    if (typeof token !== 'string' || token.length === 0) {
        return false;
    }

    return safeEqual(Buffer.from(token), Buffer.from(csrfToken(sessionValue, secret)));
}

export function parseCookies(header: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};

    for (const part of (header ?? '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) {
            continue;
        }

        const name = part.slice(0, separator).trim();
        if (name) {
            cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
        }
    }

    return cookies;
}

export function readSession(req: { headers: Record<string, unknown> }): string | undefined {
    return parseCookies(req.headers.cookie as string | undefined)[SESSION_COOKIE];
}

export function hasSession(
    req: { headers: Record<string, unknown> },
    secret: string,
    now = Date.now(),
): boolean {
    return verifySession(readSession(req), secret, now);
}

export function sessionCookie(value: string, options: { ttlMs: number; secure: boolean }): string {
    return [
        `${SESSION_COOKIE}=${value}`,
        `Path=${COOKIE_PATH}`,
        `Max-Age=${Math.floor(options.ttlMs / 1000)}`,
        'HttpOnly',
        'SameSite=Strict',
        options.secure ? 'Secure' : undefined,
    ]
        .filter(Boolean)
        .join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
    return [
        `${SESSION_COOKIE}=`,
        `Path=${COOKIE_PATH}`,
        'Max-Age=0',
        'HttpOnly',
        'SameSite=Strict',
        secure ? 'Secure' : undefined,
    ]
        .filter(Boolean)
        .join('; ');
}

/**
 * Guards the UI API: the shell and its assets stay public, everything under
 * `/api` needs a session and, when mutating, a CSRF token. Throws the matching
 * error, which the shared server answers with its usual JSON envelope, and
 * echoes a fresh CSRF token on the successful responses.
 *
 * `path` must be the mount-relative path (see `ServerRequest.path`).
 */
export function assertUiAccess(
    req: IncomingMessage,
    res: ServerResponse,
    auth: UiAuth,
    path: string,
): void {
    if (!path.startsWith(API_PATH) || (req.method === 'POST' && path === LOGIN_PATH)) {
        return;
    }

    const session = readSession(req);
    if (!session || !verifySession(session, auth.sessionSecret)) {
        throw new UnAuthorizedError('NO_SESSION');
    }

    if (
        MUTATING_METHODS.includes(req.method ?? '') &&
        !verifyCsrf(session, auth.sessionSecret, req.headers[CSRF_HEADER] as string)
    ) {
        throw new ForbiddenError('CSRF_MISMATCH');
    }

    res.setHeader(CSRF_HEADER, csrfToken(session, auth.sessionSecret));
}

function mac(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(expected: Buffer, actual: Buffer): boolean {
    return (
        expected.length > 0 &&
        expected.length === actual.length &&
        timingSafeEqual(expected, actual)
    );
}

function isHex(value: string | undefined): value is string {
    return typeof value === 'string' && value.length > 0 && /^[0-9a-f]+$/.test(value);
}
