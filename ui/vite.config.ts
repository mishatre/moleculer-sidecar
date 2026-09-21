import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
    // Biome remains the formatter/linter of record (see AGENTS.md).
    check: {
        fmt: false,
        lint: false,
    },
    // Tailwind v4: no tailwind.config.js — see src/styles.css.
    plugins: [tailwindcss()],
    // Absolute base: the SPA is served from /ui/, and relative asset URLs would
    // resolve against the site root when the mount is opened without a slash.
    base: '/ui/',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    server: {
        // The broker owns the API and the session cookie.
        proxy: {
            '/ui/api': 'http://127.0.0.1:5103',
        },
    },
});
