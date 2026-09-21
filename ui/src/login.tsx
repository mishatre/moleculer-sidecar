import { useState } from 'preact/hooks';
import { describeFailure, login } from './api';
import { Alert, Button, Card, PageShell } from './ui';

interface LoginProps {
    onSuccess: () => void;
}

const INPUT =
    'h-10 w-full rounded-lg border border-slate-300 bg-white px-3 pr-16 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:outline-2 focus:outline-offset-0 focus:outline-blue-500/40 aria-invalid:border-rose-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';

export function Login({ onSuccess }: LoginProps) {
    const [password, setPassword] = useState('');
    const [revealed, setRevealed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const handleSubmit = async (event: Event) => {
        event.preventDefault();
        if (busy || password.length === 0) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await login(password);
            setPassword('');
            onSuccess();
        } catch (thrown) {
            setError(describeFailure(thrown));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PageShell>
            <Card class="mx-auto w-full max-w-sm p-6 sm:mt-10">
                <h1 class="text-lg font-semibold tracking-tight">Sidecar access tokens</h1>
                <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Sign in to manage the credentials your clients use.
                </p>

                <form class="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
                    <div>
                        <label for="ui-password" class="mb-1.5 block text-sm font-medium">
                            Admin password
                        </label>
                        <div class="relative">
                            <input
                                id="ui-password"
                                type={revealed ? 'text' : 'password'}
                                value={password}
                                autoFocus
                                autoComplete="current-password"
                                spellcheck={false}
                                aria-invalid={error ? 'true' : undefined}
                                aria-describedby={error ? 'ui-login-error' : undefined}
                                onInput={(event) => setPassword(event.currentTarget.value)}
                                class={INPUT}
                            />
                            <button
                                type="button"
                                aria-pressed={revealed}
                                onClick={() => setRevealed((current) => !current)}
                                class="absolute inset-y-0 right-0 px-3 text-xs font-medium text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-white">
                                {revealed ? 'Hide' : 'Show'}
                            </button>
                        </div>
                    </div>

                    {error ? <Alert id="ui-login-error">{error}</Alert> : null}

                    <Button
                        type="submit"
                        class="w-full"
                        busy={busy}
                        disabled={password.length === 0}>
                        Sign in
                    </Button>
                </form>

                <p class="mt-6 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    The password is checked on the server against{' '}
                    <code class="font-mono">UI_PASSWORD_HASH</code>. Sessions last 12 hours.
                </p>
            </Card>
        </PageShell>
    );
}
