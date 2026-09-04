/**
 * Durable server-side aliases for agent profiles.
 *
 * Client agent IDs are volatile provenance identifiers. This directory lets a host associate those
 * IDs with a stable profile without making either the client ID or the alias an authorization
 * boundary. The caller principal must already have been resolved by the host before `resolve`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityContext } from './intelligence-events.js';

export interface AgentProfileAlias {
  clientId: string;
  agentId: string;
}

export interface AgentProfile {
  id: string;
  principalId: string;
  profileKey: string;
  aliases: AgentProfileAlias[];
}

export interface RegisterAgentProfileInput {
  principalId: string;
  /** Stable host-defined profile key, such as `architect` or `reviewer`. */
  profileKey: string;
  aliases: readonly AgentProfileAlias[];
}

export interface AgentProfileDirectoryOptions {
  rootDir: string;
}

export class AgentProfileAliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProfileAliasError';
  }
}

interface DirectoryFile {
  schemaVersion: '1';
  profiles: AgentProfile[];
}

const DIRECTORY_FILE = 'agent-profiles.json';

export class AgentProfileDirectory {
  private readonly rootDir: string;

  constructor(options: AgentProfileDirectoryOptions) {
    this.rootDir = options.rootDir;
  }

  list(principalId?: string): AgentProfile[] {
    return this.read()
      .profiles.filter(
        (profile) => principalId === undefined || profile.principalId === principalId,
      )
      .map(cloneProfile);
  }

  register(input: RegisterAgentProfileInput): AgentProfile {
    validateProfileInput(input);
    const file = this.read();
    const id = profileId(input.principalId, input.profileKey);
    const aliases = normalizeAliases(input.aliases);
    for (const alias of aliases) {
      const owner = file.profiles.find((profile) =>
        profile.aliases.some((candidate) => sameAlias(candidate, alias)),
      );
      if (owner && owner.id !== id) {
        throw new AgentProfileAliasError(
          `agent alias ${alias.clientId}/${alias.agentId} is already bound to ${owner.id}`,
        );
      }
    }
    const existingIndex = file.profiles.findIndex((profile) => profile.id === id);
    const existing = existingIndex < 0 ? undefined : file.profiles[existingIndex];
    const profile: AgentProfile = {
      id,
      principalId: input.principalId,
      profileKey: input.profileKey,
      aliases: normalizeAliases([...(existing?.aliases ?? []), ...aliases]),
    };
    const profiles = [...file.profiles];
    if (existingIndex >= 0) profiles[existingIndex] = profile;
    else profiles.push(profile);
    this.write({ schemaVersion: '1', profiles: profiles.sort((a, b) => a.id.localeCompare(b.id)) });
    return cloneProfile(profile);
  }

  /**
   * Resolve a configured alias within the host's principal context. Returning the unmodified base
   * context for an unknown alias is intentional: lack of a profile must never change ownership or
   * grant a caller access to a different namespace.
   */
  resolve(base: IdentityContext, source: Partial<AgentProfileAlias>): IdentityContext {
    if (!source.clientId || !source.agentId) return { ...base };
    const profile = this.read().profiles.find(
      (candidate) =>
        candidate.principalId === base.principalId &&
        candidate.aliases.some((alias) => sameAlias(alias, source as AgentProfileAlias)),
    );
    return profile ? { ...base, agentProfileId: profile.id } : { ...base };
  }

  private path(): string {
    return join(this.rootDir, DIRECTORY_FILE);
  }

  private read(): DirectoryFile {
    if (!existsSync(this.path())) return { schemaVersion: '1', profiles: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path(), 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentProfileAliasError(`invalid agent profile directory: ${message}`);
    }
    if (!isDirectoryFile(parsed))
      throw new AgentProfileAliasError('invalid agent profile directory');
    return { schemaVersion: '1', profiles: parsed.profiles.map(cloneProfile) };
  }

  private write(file: DirectoryFile): void {
    mkdirSync(this.rootDir, { recursive: true });
    const target = this.path();
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    renameSync(temp, target);
  }
}

function profileId(principalId: string, profileKey: string): string {
  return `agent-profile:${principalId}:${profileKey}`;
}

function validateProfileInput(input: RegisterAgentProfileInput): void {
  if (input.principalId.trim().length === 0)
    throw new AgentProfileAliasError('principalId is required');
  if (!/^[a-z][a-z0-9_-]*$/i.test(input.profileKey)) {
    throw new AgentProfileAliasError('profileKey must be a simple stable identifier');
  }
  if (input.aliases.length === 0)
    throw new AgentProfileAliasError('at least one alias is required');
  for (const alias of input.aliases) {
    if (alias.clientId.trim().length === 0 || alias.agentId.trim().length === 0) {
      throw new AgentProfileAliasError('agent aliases require clientId and agentId');
    }
  }
}

function normalizeAliases(aliases: readonly AgentProfileAlias[]): AgentProfileAlias[] {
  const unique = new Map<string, AgentProfileAlias>();
  for (const alias of aliases) {
    const normalized = { clientId: alias.clientId.trim(), agentId: alias.agentId.trim() };
    unique.set(`${normalized.clientId}\u0000${normalized.agentId}`, normalized);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.clientId}\u0000${a.agentId}`.localeCompare(`${b.clientId}\u0000${b.agentId}`),
  );
}

function sameAlias(left: AgentProfileAlias, right: AgentProfileAlias): boolean {
  return left.clientId === right.clientId && left.agentId === right.agentId;
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return { ...profile, aliases: profile.aliases.map((alias) => ({ ...alias })) };
}

function isDirectoryFile(value: unknown): value is DirectoryFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<DirectoryFile>;
  return (
    candidate.schemaVersion === '1' &&
    Array.isArray(candidate.profiles) &&
    candidate.profiles.every(
      (profile) =>
        typeof profile === 'object' &&
        profile !== null &&
        typeof profile.id === 'string' &&
        typeof profile.principalId === 'string' &&
        typeof profile.profileKey === 'string' &&
        Array.isArray(profile.aliases) &&
        profile.aliases.every(
          (alias) =>
            typeof alias === 'object' &&
            alias !== null &&
            typeof alias.clientId === 'string' &&
            typeof alias.agentId === 'string',
        ),
    )
  );
}
