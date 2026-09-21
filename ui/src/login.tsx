import { useState } from 'preact/hooks';
import { login, NotAuthenticated } from './api';

interface LoginProps {
    onSuccess: () => void;
}

export function Login({ onSuccess }: LoginProps) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const handleSubmit = async (event: Event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);

        try {
            await login(password);
            setPassword('');
            onSuccess();
        } catch (thrown) {
            setError(
                thrown instanceof NotAuthenticated
                    ? 'Wrong password.'
                    : thrown instanceof Error
                      ? thrown.message
                      : String(thrown),
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <form class="login" onSubmit={handleSubmit}>
            <h1>Sidecar access tokens</h1>
            <label>
                Admin password
                <input
                    type="password"
                    value={password}
                    autoFocus
                    onInput={(event) => setPassword(event.currentTarget.value)}
                />
            </label>
            <button type="submit" disabled={busy || password.length === 0}>
                Sign in
            </button>
            {error ? <p class="error">{error}</p> : null}
        </form>
    );
}
