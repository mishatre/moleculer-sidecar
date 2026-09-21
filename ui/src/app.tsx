import { useEffect, useState } from 'preact/hooks';
import {
    checkSession,
    describeFailure,
    listTokens,
    logout,
    NotAuthenticated,
    type Token,
} from './api';
import { Login } from './login';
import { TokenList } from './tokens';
import { Alert, Button, Card, PageShell, Spinner } from './ui';

type Status = 'checking' | 'locked' | 'ready';

export function App() {
    const [status, setStatus] = useState<Status>('checking');
    const [tokens, setTokens] = useState<Token[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState(false);

    function lock() {
        setTokens([]);
        setError(null);
        setStatus('locked');
    }

    const refresh = async () => {
        try {
            await checkSession();
            setTokens(await listTokens());
            setStatus('ready');
        } catch (thrown) {
            if (thrown instanceof NotAuthenticated) {
                lock();
                return;
            }
            // Never leave the user staring at a spinner: show what we have, plus why.
            setError(describeFailure(thrown));
            setStatus((current) => (current === 'checking' ? 'ready' : current));
        }
    };

    useEffect(() => {
        void refresh();
    }, []);

    const handleSignOut = async () => {
        setSigningOut(true);
        try {
            await logout();
        } catch {
            // The cookie is dropped client-side either way; lock the UI regardless.
        } finally {
            setSigningOut(false);
            lock();
        }
    };

    if (status === 'checking') {
        return (
            <PageShell>
                <Card
                    aria-busy="true"
                    class="flex items-center gap-3 p-4 text-sm text-slate-500 sm:p-5 dark:text-slate-400">
                    <Spinner />
                    Checking your session…
                </Card>
            </PageShell>
        );
    }

    if (status === 'locked') {
        return <Login onSuccess={() => void refresh()} />;
    }

    return (
        <PageShell>
            <header class="mb-6 flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 class="text-xl font-semibold tracking-tight">Sidecar access tokens</h1>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        Credentials a client uses to sign requests to the gateway.
                    </p>
                </div>
                <Button variant="secondary" busy={signingOut} onClick={() => void handleSignOut()}>
                    Sign out
                </Button>
            </header>

            {error ? (
                <Alert class="mb-5" onDismiss={() => setError(null)}>
                    {error}
                </Alert>
            ) : null}

            <TokenList
                tokens={tokens}
                onChanged={() => void refresh()}
                onLocked={lock}
                onError={setError}
            />
        </PageShell>
    );
}
