// Guards the shape of the orchestration suite: agent frontmatter, model pins,
// read-only tool boundaries, the entry-point skill, the hook configs, and the
// fact that these files are actually versionable.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(repoRoot, '.github', 'agents');
const hooksDir = path.join(repoRoot, '.github', 'hooks');
const skillsDir = path.join(repoRoot, '.github', 'skills');

const STALE_MODEL_STRINGS = [
    'Claude Sonnet 4.5 (copilot)',
    'GPT-5 (copilot)',
    'Claude Haiku 4.5 (copilot)',
];
const MODEL_PRO = 'DeepSeek V4 Pro (deepseek)';
const MODEL_FLASH = 'DeepSeek V4.1 Flash (deepseek)';
const WORKERS = ['Researcher', 'Implementer', 'Tester', 'Reviewer', 'Documenter'];

type Frontmatter = Record<string, unknown>;

const EXPECTED: { file: string; name: string; model: string }[] = [
    { file: 'coordinator', name: 'Coordinator', model: MODEL_PRO },
    { file: 'researcher', name: 'Researcher', model: MODEL_FLASH },
    { file: 'implementer', name: 'Implementer', model: MODEL_FLASH },
    { file: 'tester', name: 'Tester', model: MODEL_FLASH },
    { file: 'reviewer', name: 'Reviewer', model: MODEL_PRO },
    { file: 'documenter', name: 'Documenter', model: MODEL_FLASH },
];

function frontmatterOf(filePath: string): Frontmatter {
    const text = fs.readFileSync(filePath, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!match) throw new Error(`${filePath} has no YAML frontmatter`);
    return parseYaml(match[1]) as Frontmatter;
}

function toolsOf(frontmatter: Frontmatter): string[] {
    const tools = frontmatter.tools;
    return Array.isArray(tools) ? tools.map(String) : [];
}

function isIgnored(relativePath: string): boolean | null {
    try {
        execFileSync('git', ['check-ignore', '--quiet', relativePath], {
            cwd: repoRoot,
            stdio: 'ignore',
        });
        return true;
    } catch (error) {
        const status = (error as { status?: number }).status;
        return status === 1 ? false : null;
    }
}

describe('agent profiles', () => {
    it('defines exactly the six expected profiles', () => {
        const files = fs
            .readdirSync(agentsDir)
            .filter((entry) => entry.endsWith('.agent.md'))
            .sort();
        expect(files).toEqual(EXPECTED.map(({ file }) => `${file}.agent.md`).sort());
    });

    for (const { file, name, model } of EXPECTED) {
        describe(file, () => {
            const frontmatter = frontmatterOf(path.join(agentsDir, `${file}.agent.md`));

            it('has a discovery description and an exact name', () => {
                expect(typeof frontmatter.description).toBe('string');
                expect(String(frontmatter.description).length).toBeGreaterThan(60);
                expect(frontmatter.name).toBe(name);
            });

            it('pins a model that exists in this picker', () => {
                expect(frontmatter.model).toBe(model);
                expect(STALE_MODEL_STRINGS).not.toContain(frontmatter.model);
            });

            it('never wildcards the serena MCP server, which exposes mutation tools', () => {
                for (const tool of toolsOf(frontmatter)) {
                    expect(tool.startsWith('serena/'), `${file} must not use ${tool}`).toBe(false);
                }
            });
        });
    }

    it('keeps workers invisible in the picker and unable to delegate', () => {
        for (const name of WORKERS) {
            const file = name.toLowerCase();
            const frontmatter = frontmatterOf(path.join(agentsDir, `${file}.agent.md`));
            expect(frontmatter['user-invocable'], `${file} must be subagent-only`).toBe(false);
            expect(frontmatter.agents, `${file} must not delegate`).toEqual([]);
            expect(toolsOf(frontmatter)).not.toContain('agent');
        }
    });

    it('makes the coordinator the only entry point and lists its workers by name', () => {
        const frontmatter = frontmatterOf(path.join(agentsDir, 'coordinator.agent.md'));
        expect(frontmatter['user-invocable']).not.toBe(false);
        expect(frontmatter.agents).toEqual(WORKERS);
        expect(toolsOf(frontmatter)).toContain('agent');
    });

    it('denies mutation and terminal tools to the read-only roles', () => {
        for (const file of ['researcher', 'reviewer']) {
            const tools = toolsOf(frontmatterOf(path.join(agentsDir, `${file}.agent.md`)));
            expect(tools, `${file} may not write`).not.toContain('edit');
            expect(tools, `${file} may not run commands`).not.toContain('execute');
        }
    });

    it('keeps the documenter off the terminal', () => {
        const tools = toolsOf(frontmatterOf(path.join(agentsDir, 'documenter.agent.md')));
        expect(tools).not.toContain('execute');
        expect(tools).toContain('edit');
    });
});

describe('entry-point skill', () => {
    it('is named after its directory, which is what makes it load', () => {
        const skillDir = path.join(skillsDir, 'orchestrate');
        const frontmatter = frontmatterOf(path.join(skillDir, 'SKILL.md'));
        expect(frontmatter.name).toBe(path.basename(skillDir));
        expect(String(frontmatter.description ?? '').length).toBeGreaterThan(60);
    });

    it('is manual-only, so it never fires as background knowledge', () => {
        const frontmatter = frontmatterOf(path.join(skillsDir, 'orchestrate', 'SKILL.md'));
        expect(frontmatter['disable-model-invocation']).toBe(true);
    });
});

describe('hook configuration', () => {
    const configs = fs.readdirSync(hooksDir).filter((entry) => entry.endsWith('.json'));

    it('ships the three hook configs', () => {
        expect(configs.sort()).toEqual([
            'post-tool-use.json',
            'pre-tool-use.json',
            'session-start.json',
        ]);
    });

    it('registers the documented lifecycle events', () => {
        const events = new Set<string>();
        for (const config of configs) {
            const parsed = JSON.parse(fs.readFileSync(path.join(hooksDir, config), 'utf8')) as {
                hooks?: Record<string, unknown[]>;
            };
            for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
                expect(Array.isArray(entries) && entries.length > 0, `${config} ${event}`).toBe(
                    true,
                );
                events.add(event);
            }
        }
        expect([...events].sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
    });

    it('points every command at a script that exists', () => {
        for (const config of configs) {
            const parsed = JSON.parse(fs.readFileSync(path.join(hooksDir, config), 'utf8')) as {
                hooks?: Record<string, { type?: string; command?: string }[]>;
            };
            for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
                for (const entry of entries) {
                    expect(entry.type, `${config} ${event}`).toBe('command');
                    const target = String(entry.command ?? '')
                        .split(/\s+/)
                        .pop();
                    expect(target, `${config} ${event} has no command`).toBeTruthy();
                    expect(
                        fs.existsSync(path.join(repoRoot, String(target))),
                        `${config} ${event} -> ${target}`,
                    ).toBe(true);
                }
            }
        }
    });
});

describe('versioning', () => {
    it('negates the markdown ignore so the suite and AGENTS.md are tracked', () => {
        const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
        expect(gitignore).toContain('!.github/**');
        expect(gitignore).toContain('!AGENTS.md');
    });

    it('does not leave future .github helpers hidden by the *.sh / *.txt rules', () => {
        // git check-ignore matches paths that do not exist yet, which is the point:
        // this guards the next file someone adds, not today's tree.
        for (const future of [
            '.github/hooks/scripts/helper.sh',
            '.github/hooks/scripts/notes.txt',
            '.github/agents/extra.agent.md',
        ]) {
            const ignored = isIgnored(future);
            if (ignored === null) continue; // git unavailable
            expect(ignored, `${future} would be ignored by git`).toBe(false);
        }
    });

    it('leaves every deliverable visible to git', () => {
        const deliverables = [
            'AGENTS.md',
            ...EXPECTED.map(({ file }) => `.github/agents/${file}.agent.md`),
            '.github/skills/orchestrate/SKILL.md',
            '.github/hooks/scripts/README.md',
        ];
        for (const deliverable of deliverables) {
            const ignored = isIgnored(deliverable);
            if (ignored === null) continue; // git unavailable: rule check above still applies
            expect(ignored, `${deliverable} is ignored by git`).toBe(false);
        }
    });
});
