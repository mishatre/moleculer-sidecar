export interface Token {
    accessKey: string;
}

export interface TokenPair {
    accessKey: string;
    secretKey: string;
}

/** API error codes worth spelling out; anything else is shown verbatim. */
const MESSAGES: Record<string, string> = {
    INVALID_PASSWORD: 'Wrong password.',
    NO_SESSION: 'Your session expired — please sign in again.',
    CSRF_MISMATCH: 'Your session expired — please sign in again.',
    ACCESS_KEY_NOT_FOUND: 'That access key no longer exists.',
    FORBIDDEN: 'This page is only reachable from the server itself.',
    UNKNOWN_UI_API_ROUTE: 'That API route does not exist.',
};

function describeCode(code: string): string {
    return MESSAGES[code] ?? code;
}

/** Thrown when the API refuses the request because the session is gone. */
export class NotAuthenticated extends Error {
    /** The API error code, e.g. `NO_SESSION`, `CSRF_MISMATCH`, `INVALID_PASSWORD`. */
    public readonly code: string;

    constructor(code = 'NO_SESSION') {
        super(describeCode(code));
        this.name = 'NotAuthenticated';
        this.code = code;
    }
}

/** Thrown for any other failed request, carrying a message fit for a human. */
export class ApiError extends Error {
    public readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

/** Readable text for anything thrown by this module. */
export function describeFailure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const API_BASE = '/ui/api';
const CSRF_HEADER = 'x-ui-csrf';

let csrfToken = '';

/** The gateway answers errors as `{ name, message, code, type }`; `message` is the code. */
async function errorCode(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { message?: unknown };
        return typeof body.message === 'string' ? body.message : '';
    } catch {
        // Not JSON (a proxy, or a plain-text 500) — fall back to the status line.
        return '';
    }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers = new Headers(options.headers);

    if (method !== 'GET' && csrfToken) {
        headers.set(CSRF_HEADER, csrfToken);
    }
    if (options.body != null) {
        headers.set('content-type', 'application/json');
    }

    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        method,
        headers,
        credentials: 'same-origin',
    });

    // The guard echoes a fresh token on every authenticated response.
    const fresh = response.headers.get(CSRF_HEADER);
    if (fresh) {
        csrfToken = fresh;
    }

    if (!response.ok) {
        const code = await errorCode(response);
        // A stale CSRF token means the session went away underneath us: lock the
        // UI instead of surfacing a 403 the user can do nothing about.
        if (response.status === 401 || code === 'CSRF_MISMATCH') {
            csrfToken = '';
            throw new NotAuthenticated(code || 'NO_SESSION');
        }
        throw new ApiError(
            response.status,
            code ? describeCode(code) : `${response.status} ${response.statusText}`,
        );
    }

    return (await response.json()) as T;
}

export async function login(password: string): Promise<void> {
    const session = await request<{ csrfToken: string }>('/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
    });

    csrfToken = session.csrfToken;
}

export async function logout(): Promise<void> {
    await request<{ ok: boolean }>('/logout', { method: 'POST' });
    csrfToken = '';
}

export function listTokens(): Promise<Token[]> {
    return request<Token[]>('/tokens');
}

export function createToken(): Promise<TokenPair> {
    return request<TokenPair>('/tokens', { method: 'POST' });
}

export function revokeToken(accessKey: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/tokens/${encodeURIComponent(accessKey)}`, {
        method: 'DELETE',
    });
}

export function checkSession(): Promise<{ authenticated: boolean }> {
    return request<{ authenticated: boolean }>('/session');
}
