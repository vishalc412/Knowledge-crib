import edgeSchema from './schema/edge.schema.json' with { type: 'json' };
import manifestSchema from './schema/manifest.schema.json' with { type: 'json' };
/**
 * The vendored JSON Schemas as plain objects, so `core` (and any consumer) can hand them to ajv
 * without filesystem lookups. They are also written verbatim into `.crib/schema/` at index time so
 * a soul is self-describing (soul-format §2).
 */
import nodeSchema from './schema/node.schema.json' with { type: 'json' };

export const NODE_SCHEMA = nodeSchema as Record<string, unknown>;
export const EDGE_SCHEMA = edgeSchema as Record<string, unknown>;
export const MANIFEST_SCHEMA = manifestSchema as Record<string, unknown>;

/** Map of file-name → schema object, for writing the self-describing `.crib/schema/` directory. */
export const VENDORED_SCHEMAS: Record<string, Record<string, unknown>> = {
  'node.schema.json': NODE_SCHEMA,
  'edge.schema.json': EDGE_SCHEMA,
  'manifest.schema.json': MANIFEST_SCHEMA,
};
