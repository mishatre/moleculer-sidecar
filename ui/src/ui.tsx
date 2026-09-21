import type { ComponentChildren, JSX } from 'preact';

/*
 * Presentation primitives. The Tailwind utilities live here so the screens stay
 * readable and every state (busy, disabled, focus, dark mode) looks the same.
 */

// #region layout

export function PageShell({ children }: { children: ComponentChildren }) {
    return (
        <div class="min-h-dvh bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
            <div class="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">{children}</div>
        </div>
    );
}

const CARD_TONES = {
    plain: 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
    warn: 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40',
} as const;

export interface CardProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, 'class'> {
    tone?: keyof typeof CARD_TONES;
    class?: string;
}

/** Surface only — padding is left to the caller so utilities never collide. */
export function Card({ tone = 'plain', class: className, children, ...rest }: CardProps) {
    return (
        <div {...rest} class={`rounded-xl border shadow-sm ${CARD_TONES[tone]} ${className ?? ''}`}>
            {children}
        </div>
    );
}

// #endregion

// #region feedback

export function Spinner({ class: className }: { class?: string }) {
    return (
        <span
            aria-hidden="true"
            class={`inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none ${className ?? ''}`}
        />
    );
}

const ALERT_TONES = {
    error: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
    info: 'border-slate-200 bg-white text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200',
} as const;

export interface AlertProps {
    tone?: keyof typeof ALERT_TONES;
    id?: string;
    class?: string;
    children: ComponentChildren;
    onDismiss?: () => void;
}

export function Alert({ tone = 'error', id, class: className, children, onDismiss }: AlertProps) {
    return (
        <div
            id={id}
            role={tone === 'error' ? 'alert' : 'status'}
            class={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${ALERT_TONES[tone]} ${className ?? ''}`}>
            <p class="min-w-0 flex-1">{children}</p>
            {onDismiss ? (
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss"
                    class="-mt-1 -mr-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100">
                    ✕
                </button>
            ) : null}
        </div>
    );
}

// #endregion

// #region controls

const BUTTON_BASE =
    'inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:pointer-events-none disabled:opacity-50';

const BUTTON_VARIANTS = {
    primary: 'bg-blue-600 text-white shadow-sm hover:bg-blue-700 active:bg-blue-800',
    secondary:
        'border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
    danger: 'border border-rose-300 bg-white text-rose-700 shadow-sm hover:bg-rose-50 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-300 dark:hover:bg-rose-950',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white',
} as const;

const BUTTON_SIZES = {
    sm: 'h-8 px-2.5 text-xs',
    md: 'h-10 px-4 text-sm',
} as const;

export interface ButtonProps
    extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'class'> {
    variant?: keyof typeof BUTTON_VARIANTS;
    size?: keyof typeof BUTTON_SIZES;
    class?: string;
    /** Shows a spinner and blocks further clicks. */
    busy?: boolean;
}

export function Button({
    variant = 'primary',
    size = 'md',
    busy = false,
    disabled,
    class: className,
    children,
    ...rest
}: ButtonProps) {
    return (
        <button
            {...rest}
            type={rest.type ?? 'button'}
            disabled={disabled || busy}
            aria-busy={busy ? 'true' : undefined}
            class={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className ?? ''}`}>
            {busy ? <Spinner /> : null}
            {children}
        </button>
    );
}

// #endregion
