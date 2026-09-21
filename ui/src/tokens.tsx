import { useState } from 'preact/hooks';
import {
    createToken,
    describeFailure,
    NotAuthenticated,
    revokeToken,
    type Token,
    type TokenPair,
} from './api';
import { Button, Card } from './ui';

interface TokenListProps {
    tokens: Token[];
    onChanged: () => void;
    onLocked: () => void;
    onError: (message: string) => void;
}

type SecretField = 'accessKey' | 'secretKey';

/**
 * `navigator.clipboard` needs a secure context and the gateway is often plain
 * http on the LAN, so fall back to the legacy selection copy.
 */
async function writeClipboard(value: string): Promise<boolean> {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch {
        // Fall through to the legacy path.
    }

    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
}

export function TokenList({ tokens, onChanged, onLocked, onError }: TokenListProps) {
    const [created, setCreated] = useState<TokenPair | null>(null);
    const [creating, setCreating] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [copied, setCopied] = useState<SecretField | null>(null);

    const failed = (thrown: unknown) => {
        if (thrown instanceof NotAuthenticated) {
            onLocked();
            return;
        }
        onError(describeFailure(thrown));
    };

    const handleCreate = async () => {
        setCreating(true);
        try {
            setCreated(await createToken());
            setCopied(null);
            onChanged();
        } catch (thrown) {
            failed(thrown);
        } finally {
            setCreating(false);
        }
    };

    const handleRevoke = async (accessKey: string) => {
        setPending(accessKey);
        try {
            await revokeToken(accessKey);
            setCreated(null);
            setConfirming(null);
            onChanged();
        } catch (thrown) {
            failed(thrown);
        } finally {
            setPending(null);
        }
    };

    const copy = async (field: SecretField, value: string) => {
        if (await writeClipboard(value)) {
            setCopied(field);
            window.setTimeout(
                () => setCopied((current) => (current === field ? null : current)),
                1500,
            );
            return;
        }
        onError('Your browser blocked the copy — select the field and copy it manually.');
    };

    return (
        <section>
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 class="flex items-center gap-2 text-base font-semibold">
                    Access tokens
                    {tokens.length > 0 ? (
                        <span class="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            {tokens.length}
                        </span>
                    ) : null}
                </h2>
                <Button busy={creating} onClick={() => void handleCreate()}>
                    Create token
                </Button>
            </div>

            {created ? (
                <Card tone="warn" role="status" class="mb-5 p-4 sm:p-5">
                    <h3 class="text-sm font-semibold text-amber-900 dark:text-amber-100">
                        Copy the secret now — it is not shown again
                    </h3>
                    <p class="mt-1 text-sm text-amber-800 dark:text-amber-200/90">
                        Store it where the client that signs through the gateway can read it.
                    </p>

                    <dl class="mt-4 space-y-3">
                        {(['accessKey', 'secretKey'] as const).map((field) => (
                            <div key={field}>
                                <dt class="text-xs font-medium tracking-wide text-amber-900/80 uppercase dark:text-amber-200/80">
                                    {field === 'accessKey' ? 'Access key' : 'Secret key'}
                                </dt>
                                <dd class="mt-1 flex items-center gap-2">
                                    <input
                                        readOnly
                                        value={created[field]}
                                        onFocus={(event) => event.currentTarget.select()}
                                        class="h-9 min-w-0 flex-1 rounded-md border border-amber-300 bg-white/80 px-2 font-mono text-xs text-slate-900 dark:border-amber-700 dark:bg-slate-950 dark:text-slate-100"
                                    />
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => void copy(field, created[field])}>
                                        {copied === field ? 'Copied' : 'Copy'}
                                    </Button>
                                </dd>
                            </div>
                        ))}
                    </dl>

                    <div class="mt-4 flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                            Done
                        </Button>
                    </div>
                </Card>
            ) : null}

            {tokens.length === 0 ? (
                <Card class="border-dashed p-6 text-center sm:p-8">
                    <p class="text-sm font-medium">No access tokens yet</p>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        Create one to give a client a signing credential.
                    </p>
                </Card>
            ) : (
                <Card class="overflow-hidden">
                    <table class="w-full text-sm">
                        <thead class="bg-slate-50 text-xs tracking-wide text-slate-500 uppercase dark:bg-slate-950/50 dark:text-slate-400">
                            <tr>
                                <th scope="col" class="px-4 py-2.5 text-left font-medium">
                                    Access key
                                </th>
                                <th scope="col" class="px-4 py-2.5 text-right font-medium">
                                    Actions
                                </th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-200 dark:divide-slate-800">
                            {tokens.map((token) => (
                                <tr
                                    key={token.accessKey}
                                    class="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                    <td class="px-4 py-2.5">
                                        <code class="font-mono text-xs break-all">
                                            {token.accessKey}
                                        </code>
                                    </td>
                                    <td class="px-4 py-2.5 text-right whitespace-nowrap">
                                        {confirming === token.accessKey ? (
                                            <span class="inline-flex items-center gap-2">
                                                <span class="text-xs text-slate-500 dark:text-slate-400">
                                                    Revoke this token?
                                                </span>
                                                <Button
                                                    size="sm"
                                                    variant="danger"
                                                    busy={pending === token.accessKey}
                                                    onClick={() =>
                                                        void handleRevoke(token.accessKey)
                                                    }>
                                                    Revoke
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => setConfirming(null)}>
                                                    Cancel
                                                </Button>
                                            </span>
                                        ) : (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={pending !== null}
                                                onClick={() => setConfirming(token.accessKey)}>
                                                Revoke
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Card>
            )}
        </section>
    );
}
