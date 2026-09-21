import { useState } from 'preact/hooks';
import type { Token, TokenPair } from './api';
import { createToken, NotAuthenticated, revokeToken } from './api';

interface TokenListProps {
    tokens: Token[];
    onChanged: () => void;
    onLocked: () => void;
    onError: (message: string) => void;
}

export function TokenList({ tokens, onChanged, onLocked, onError }: TokenListProps) {
    const [created, setCreated] = useState<TokenPair | null>(null);
    const [busy, setBusy] = useState(false);

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } catch (thrown) {
            if (thrown instanceof NotAuthenticated) {
                onLocked();
                return;
            }
            onError(thrown instanceof Error ? thrown.message : String(thrown));
        } finally {
            setBusy(false);
        }
    };

    const handleCreate = () =>
        run(async () => {
            setCreated(await createToken());
            onChanged();
        });

    const handleRevoke = (token: Token) =>
        run(async () => {
            await revokeToken(token.accessKey);
            setCreated(null);
            onChanged();
        });

    return (
        <section>
            <header class="row">
                <h2>Access tokens</h2>
                <button type="button" disabled={busy} onClick={handleCreate}>
                    Create token
                </button>
            </header>

            {created ? (
                <aside class="created">
                    <p>
                        <strong>Copy the secret now</strong> — it is shown once and cannot be
                        retrieved later.
                    </p>
                    <label>
                        Access key
                        <input readOnly value={created.accessKey} />
                    </label>
                    <label>
                        Secret key
                        <input readOnly value={created.secretKey} />
                    </label>
                    <button type="button" onClick={() => setCreated(null)}>
                        Done
                    </button>
                </aside>
            ) : null}

            {tokens.length === 0 ? (
                <p class="muted">No access tokens yet.</p>
            ) : (
                <table>
                    <thead>
                        <tr>
                            <th>Access key</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {tokens.map((token) => (
                            <tr key={token.accessKey}>
                                <td>
                                    <code>{token.accessKey}</code>
                                </td>
                                <td class="right">
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => handleRevoke(token)}>
                                        Revoke
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
