/**
 * Snippet rehydration — re-exported from @knowledge-crib/core so the serving layer (verbs) and the
 * persisted-dossier builder share ONE implementation. The logic lives in core/src/source.ts because
 * the dossier builder (core) must embed the rehydrated body without depending on the mcp package.
 *
 * See {@link ../core/src/source.ts} for the full-depth + line-offset-paging contract.
 */
export {
  DEFAULT_BODY_MAX_CHARS,
  DEFAULT_BODY_MAX_LINES,
  rehydrate,
  rehydrateBody,
} from '@knowledge-crib/core';
export type { RehydratedBody } from '@knowledge-crib/core';
