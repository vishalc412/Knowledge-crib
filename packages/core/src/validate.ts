import { EDGE_SCHEMA, MANIFEST_SCHEMA, NODE_SCHEMA } from '@knowledge-crib/soul-schema';
import type { Edge, Manifest, Node } from '@knowledge-crib/soul-schema';
/**
 * Record validation against the vendored JSON Schemas (invariant #4: closed enums for
 * kind/rel/method/provenance; unknown values → validation error). Compiled once, reused per record.
 */
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

const validateNodeFn: ValidateFunction = ajv.compile(NODE_SCHEMA);
const validateEdgeFn: ValidateFunction = ajv.compile(EDGE_SCHEMA);
const validateManifestFn: ValidateFunction = ajv.compile(MANIFEST_SCHEMA);

/** Thrown when a record fails schema validation before a write. */
export class SchemaValidationError extends Error {
  constructor(
    kind: string,
    public readonly errors: unknown,
    id?: string,
  ) {
    super(`${kind} schema validation failed${id ? ` for ${id}` : ''}: ${JSON.stringify(errors)}`);
    this.name = 'SchemaValidationError';
  }
}

export function assertValidNode(node: Node): void {
  // Capture as boolean: ajv returns a type predicate, which would otherwise narrow `node` to never.
  const ok: boolean = validateNodeFn(node);
  if (!ok) throw new SchemaValidationError('node', validateNodeFn.errors, node.id);
}

export function assertValidEdge(edge: Edge): void {
  const ok: boolean = validateEdgeFn(edge);
  if (!ok) throw new SchemaValidationError('edge', validateEdgeFn.errors, edge.id);
}

export function assertValidManifest(manifest: Manifest): void {
  const ok: boolean = validateManifestFn(manifest);
  if (!ok) throw new SchemaValidationError('manifest', validateManifestFn.errors);
}
