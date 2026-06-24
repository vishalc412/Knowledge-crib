/**
 * @knowledge-crib/pipeline — the phased extract→graph→index pipeline.
 */
export * from './structure.js';
export * from './parse.js';
export * from './pipeline.js';
export * from './resolve/index.js';
export * from './linker/index.js';
export * from './update.js';
export * from './vcs.js';
export { makeExtractCtx } from './extract-ctx.js';
