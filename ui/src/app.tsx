import { useEffect, useState } from 'preact/hooks';
import { checkSession, listTokens, logout, NotAuthenticated, type Token } from './api';
import { Login } from './login';
import { TokenList } from './tokens';

type Status = 'checking' | 'locked' | 'ready';

export function App() {
    const [status, setStatus] = useState<Status>('checking');
    const [tokens, setTokens] = useState<Token[]>([]);
    const [error, setError] = useState<string | null>(null);

    const refresh = async () => {
        try {
            await checkSession();
            setTokens(await listTokens());
            setStatus('ready');
        } catch (thrown) {
            if (thrown instanceof NotAuthenticated) {
                setStatus('locked');
                return;
            }
            setError(thrown instanceof Error ? thrown.message : String(thrown));
        }
    };

    useEffect(() => {
        void refresh();
    }, []);

    const lock = () => {
        setTokens([]);
        setStatus('locked');
    };

    const handleSignOut = async () => {
        try {
            await logout();
        } finally {
            lock();
        }
    };

    if (status === 'checking') {
        return <p class="muted">Loading…</p>;
    }

    if (status === 'locked') {
        return <Login onSuccess={() => void refresh()} />;
    }

    return (
        <main>
            <header class="row">
                <h1>Sidecar access tokens</h1>
                <button type="button" onClick={handleSignOut}>
                    Sign out
                </button>
            </header>

            {error ? <p class="error">{error}</p> : null}

            <TokenList
                tokens={tokens}
                onChanged={() => void refresh()}
                onLocked={lock}
                onError={setError}
            />
        </main>
    );
}
