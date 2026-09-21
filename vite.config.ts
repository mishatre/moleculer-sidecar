import { defineConfig } from 'vite-plus';

export default defineConfig({
    // Biome remains the formatter/linter of record in this repo (see AGENTS.md).
    // Disable the composite `vp check` steps that would run a second toolchain.
    check: {
        fmt: false,
        lint: false,
    },
    fmt: {
        // Mirrors the Biome settings so an explicit `vp fmt` run does not churn
        // the tree. Biome is still the tool that gates formatting here.
        printWidth: 100,
        tabWidth: 4,
        singleQuote: true,
        semi: true,
        trailingComma: 'all',
        bracketSpacing: true,
        bracketSameLine: true,
        arrowParens: 'always',
        // Don't re-sort package.json (migrate's default) and leave files owned
        // by other tools alone; Biome is the formatter of record for those.
        sortPackageJson: false,
        ignorePatterns: ['.serena/**', 'pnpm-workspace.yaml'],
    },
    lint: {
        jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
        rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
        options: { typeAware: true, typeCheck: true },
    },
    test: {
        include: ['src/**/*.test.ts'],
    },
});
