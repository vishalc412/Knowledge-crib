/**
 * `crib skill install|list` — ship + install the bundled `/crib-enrich` skill so it is usable via
 * knowledge-crib, not just from a hand-written `~/.claude/skills/` dir.
 *
 * Mirrors two existing patterns:
 *  - **Asset bundling** like `@knowledge-crib/ui`'s `vizAssetsDir()` (`packages/ui/src/viz.ts`): the
 *    skill ships as a non-TS static dir at `packages/cli/skills/` (sibling of `src`/`dist`, listed in
 *    `package.json` `files`), and {@link skillsDir} resolves it via `dirname(__dirname)` so it works
 *    against source at dev time AND against the published package (where `__dirname` is `dist/`).
 *  - **Idempotent install** like `mcp-install.ts`: copy the bundled skill dir into the user's
 *    `~/.claude/skills/<name>/`, skipping byte-identical re-installs (no clobber, no managed-block
 *    markers needed — the skill is a single self-contained file).
 *
 * The skill is the *driver* of the LLM-graph loop (Phase E of the grove plan): the host IDE LLM runs
 * `enrich_status → enrich_next → author → enrich_save` over MCP. Bundling it here means `crib skill
 * install` is the one command that makes LLM-graph generation available in any Claude Code install.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM has no `__dirname`; derive it from `import.meta.url` (same shim `@knowledge-crib/ui`'s viz.ts uses).
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled skills dir (`packages/cli/skills` at dev, `<pkg>/skills` published). */
export function skillsDir(): string {
  // src/skill-install.ts → ../skills  (dist/skill-install.js → ../skills after build — same shape)
  return join(dirname(__dirname), 'skills');
}

export interface BundledSkill {
  /** Skill folder name (e.g. `crib-enrich`), also the install dir name under `~/.claude/skills/`. */
  name: string;
  /** Absolute path to the bundled skill folder. */
  sourceDir: string;
  /** Skill description parsed from the SKILL.md frontmatter (`description:`), for `list`. */
  description?: string;
}

export interface SkillInstallOptions {
  /** Skill name to install; omit to install every bundled skill. */
  name?: string;
  /** Destination root; defaults to `~/.claude/skills` (Claude Code's user skill dir). */
  destRoot?: string;
}

export interface SkillInstallResult {
  name: string;
  /** Absolute destination skill dir written. */
  destDir: string;
  /** Whether the skill was copied vs already present and byte-identical. */
  written: boolean;
  /** Note for the user (e.g. unsupported combo, missing skill). Non-fatal. */
  note?: string;
}

/** Default install target: Claude Code's user-level skills dir. */
export function defaultSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills');
}

/** List every bundled skill (each subfolder of `skills/` containing a SKILL.md). */
export function listBundledSkills(): BundledSkill[] {
  const root = skillsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((d) => {
      const sourceDir = join(root, d.name);
      const skillFile = join(sourceDir, 'SKILL.md');
      return { name: d.name, sourceDir, description: readDescription(skillFile) };
    })
    .filter((s) => existsSync(join(s.sourceDir, 'SKILL.md')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Install one bundled skill (or all, when `name` is omitted) into `destRoot/<name>/`. Idempotent: a
 * destination that already holds byte-identical content is reported `written: false` and left alone.
 */
export function installSkill(opts: SkillInstallOptions = {}): SkillInstallResult[] {
  const destRoot = opts.destRoot ?? defaultSkillsRoot();
  const skills = opts.name
    ? listBundledSkills().filter((s) => s.name === opts.name)
    : listBundledSkills();
  if (opts.name && skills.length === 0) {
    return [
      {
        name: opts.name,
        destDir: '',
        written: false,
        note: `no bundled skill named '${opts.name}'`,
      },
    ];
  }
  return skills.map((skill) => installOne(skill, destRoot));
}

function installOne(skill: BundledSkill, destRoot: string): SkillInstallResult {
  const destDir = join(destRoot, skill.name);
  mkdirSync(destDir, { recursive: true });
  if (dirEquals(skill.sourceDir, destDir)) {
    return { name: skill.name, destDir, written: false, note: 'already up to date' };
  }
  cpSync(skill.sourceDir, destDir, { recursive: true, force: true });
  return { name: skill.name, destDir, written: true };
}

/** Parse the `description:` field from SKILL.md YAML frontmatter (best-effort, single-line). */
function readDescription(skillFile: string): string | undefined {
  try {
    const text = readFileSync(skillFile, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return undefined;
    const desc = fm[1]?.match(/^description:\s*(.+)$/m);
    return desc?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** True when every file under `a` exists under `b` with identical content (byte-identical skill). */
function dirEquals(a: string, b: string): boolean {
  if (!existsSync(b)) return false;
  const aFiles = walk(a);
  const bFiles = walk(b);
  if (aFiles.length !== bFiles.length) return false;
  for (const rel of aFiles) {
    const af = join(a, rel);
    const bf = join(b, rel);
    if (!existsSync(bf)) return false;
    if (statSync(af).size !== statSync(bf).size) return false;
    if (readFileSync(af, 'utf8') !== readFileSync(bf, 'utf8')) return false;
  }
  return true;
}

function walk(root: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${name.name}` : name.name;
    if (name.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out.sort();
}
