import { describe, expect, it } from 'vite-plus/test';
import {
    assertUiAccess,
    CSRF_HEADER,
    clearedSessionCookie,
    createSession,
    csrfToken,
    hashPassword,
    hasSession,
    isPasswordHash,
    parseCookies,
    readSession,
    resolveUiAuth,
    SESSION_COOKIE,
    sessionCookie,
    type UiAuth,
    verifyCsrf,
    verifyPassword,
    verifySession,
} from '../src/ui/auth.js';

const SECRET = 's'.repeat(40);

const auth: UiAuth = {
    passwordHash: hashPassword('correct horse'),
    sessionSecret: SECRET,
    ttlMs: 60_000,
};

interface FakeRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
}

function request(overrides: Partial<FakeRequest> = {}): FakeRequest {
    return { url: '/api/tokens', method: 'GET', headers: {}, ...overrides };
}

function response() {
    const headers: Record<string, string> = {};
    return {
        headers,
        res: { setHeader: (name: string, value: string) => void (headers[name] = value) },
    };
}

describe('ui password', () => {
    it('verifies the matching password only', () => {
        const hash = hashPassword('correct horse');

        expect(isPasswordHash(hash)).toBe(true);
        expect(hash.startsWith('scrypt$')).toBe(true);
        expect(hash).not.toContain('correct horse');
        expect(verifyPassword('correct horse', hash)).toBe(true);
        expect(verifyPassword('correct hors', hash)).toBe(false);
    });

    it('rejects malformed stored hashes instead of throwing', () => {
        expect(verifyPassword('x', 'plain')).toBe(false);
        expect(verifyPassword('x', 'scrypt$$')).toBe(false);
        expect(verifyPassword('x', 'scrypt$zz$zz')).toBe(false);
        expect(verifyPassword('x', '')).toBe(false);
    });
});

describe('ui sessions', () => {
    it('round-trips a signed session and rejects tampering or expiry', () => {
        const { value } = createSession(SECRET, 1000, 1_000);

        expect(verifySession(value, SECRET, 1_500)).toBe(true);
        expect(verifySession(value, SECRET, 2_001)).toBe(false);
        expect(verifySession(value, 'x'.repeat(40), 1_500)).toBe(false);
        expect(verifySession(`${value}tampered`, SECRET, 1_500)).toBe(false);
        expect(verifySession(undefined, SECRET)).toBe(false);
    });

    it('binds the csrf token to its session', () => {
        const session = createSession(SECRET, 1000, 1_000).value;
        const other = createSession(SECRET, 1000, 5_000).value;

        expect(verifyCsrf(session, SECRET, csrfToken(session, SECRET))).toBe(true);
        expect(verifyCsrf(session, SECRET, csrfToken(other, SECRET))).toBe(false);
        expect(verifyCsrf(session, SECRET, 'nope')).toBe(false);
        expect(verifyCsrf(session, SECRET, undefined)).toBe(false);
    });

    it('reads the session from the cookie header', () => {
        const session = createSession(SECRET, 60_000).value;
        const cookie = `other=1; ${SESSION_COOKIE}=${session}; trailing=2`;

        expect(parseCookies(cookie)).toMatchObject({ other: '1', trailing: '2' });
        expect(readSession({ headers: { cookie } })).toBe(session);
        expect(readSession({ headers: {} })).toBeUndefined();
        expect(hasSession({ headers: { cookie } }, SECRET)).toBe(true);
        expect(hasSession({ headers: {} }, SECRET)).toBe(false);
    });

    it('builds and clears the cookie header', () => {
        expect(sessionCookie('v', { ttlMs: 60_000, secure: true })).toBe(
            `${SESSION_COOKIE}=v; Path=/ui; Max-Age=60; HttpOnly; SameSite=Strict; Secure`,
        );
        expect(sessionCookie('v', { ttlMs: 60_000, secure: false })).not.toContain('Secure');
        expect(clearedSessionCookie(true)).toBe(
            `${SESSION_COOKIE}=; Path=/ui; Max-Age=0; HttpOnly; SameSite=Strict; Secure`,
        );
    });
});

describe('resolveUiAuth', () => {
    it('refuses an unconfigured or weak setup', () => {
        expect(() => resolveUiAuth({})).toThrow(/UI_PASSWORD_HASH/);
        expect(() => resolveUiAuth({ UI_PASSWORD_HASH: 'plain' })).toThrow(/UI_PASSWORD_HASH/);
        expect(() => resolveUiAuth({ UI_PASSWORD_HASH: hashPassword('x') })).toThrow(
            /UI_SESSION_SECRET/,
        );
        expect(() =>
            resolveUiAuth({
                UI_PASSWORD_HASH: hashPassword('x'),
                UI_SESSION_SECRET: 'too-short',
            }),
        ).toThrow(/UI_SESSION_SECRET/);
    });

    it('accepts a complete setup', () => {
        const config = resolveUiAuth({
            UI_PASSWORD_HASH: hashPassword('x'),
            UI_SESSION_SECRET: 's'.repeat(32),
        });

        expect(config.ttlMs).toBeGreaterThan(0);
    });
});

describe('assertUiAccess', () => {
    const session = createSession(SECRET, 60_000).value;
    const cookie = { cookie: `${SESSION_COOKIE}=${session}` };

    it('lets the shell, the assets and the login call through', () => {
        const cases: [string, string][] = [
            ['/', 'GET'],
            ['/assets/index-abc.js', 'GET'],
            ['/api/login', 'POST'],
        ];

        for (const [url, method] of cases) {
            const req = request({ url, method });

            expect(() =>
                assertUiAccess(req as never, response().res as never, auth, url),
            ).not.toThrow();
        }
    });

    it('rejects an api call without a session', () => {
        let error: unknown;
        try {
            assertUiAccess(request() as never, response().res as never, auth, '/api/tokens');
        } catch (caught) {
            error = caught;
        }

        expect(error).toMatchObject({ code: 401, type: 'NO_SESSION' });
    });

    it('rejects a mutation without a matching csrf token', () => {
        const req = request({ method: 'DELETE', headers: cookie });
        let error: unknown;
        try {
            assertUiAccess(req as never, response().res as never, auth, '/api/tokens');
        } catch (caught) {
            error = caught;
        }

        expect(error).toMatchObject({ code: 403, type: 'CSRF_MISMATCH' });
    });

    it('passes an authenticated mutation and echoes a fresh csrf token', () => {
        const { res, headers } = response();
        const req = request({
            method: 'POST',
            headers: { ...cookie, [CSRF_HEADER]: csrfToken(session, SECRET) },
        });

        expect(() => assertUiAccess(req as never, res as never, auth, '/api/tokens')).not.toThrow();
        expect(headers[CSRF_HEADER]).toBe(csrfToken(session, SECRET));
    });
});
