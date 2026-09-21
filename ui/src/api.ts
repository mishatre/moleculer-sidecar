export interface Token {
    accessKey: string;
}

export interface TokenPair {
    accessKey: string;
    secretKey: string;
}

/** Thrown when the API refuses the request because the session is gone. */
export class NotAuthenticated extends Error {
    constructor() {
        super('not authenticated');
    }
}

const API_BASE = '/ui/api';
const CSRF_HEADER = 'x-ui-csrf';

let csrfToken = '';

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

    if (response.status === 401) {
        csrfToken = '';
        throw new NotAuthenticated();
    }
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
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
