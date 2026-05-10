/**
 * Lineage graph builder — `lineageGraph(receipts)`
 *
 * Reconstructs the data lineage graph from an array of Stoa receipts.
 * Each receipt records which resources were consumed/produced.
 *
 * Reference: STOA.md §16 (sandbox, replay, lineage), §5.2 (lineage field).
 */

import type {
  Receipt,
  LineageGraph,
  LineageNode,
  LineageEdge,
  CapabilityURN,
} from "./types.js";

// ---------------------------------------------------------------------------
// Extended receipt with lineage field
// ---------------------------------------------------------------------------

export interface ReceiptWithLineage extends Receipt {
  lineage?: {
    consumed_resources?: string[];
    produced_resource?: string;
  };
  state_delta?: {
    resource: string;
    version: number;
    changeset: unknown[];
  };
}

// ---------------------------------------------------------------------------
// lineageGraph
// ---------------------------------------------------------------------------

/**
 * Build a data lineage graph from an array of receipts.
 *
 * Nodes are resources (identified by URN). Edges connect resources that
 * were consumed by a capability and the resource it produced.
 *
 * The graph can be used for:
 * - Audit: trace every data access back to a source
 * - Replay: find all steps that touched a resource
 * - Compliance: identify which capabilities accessed PII resources
 */
export function lineageGraph(receipts: ReceiptWithLineage[]): LineageGraph {
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const edgeSet = new Set<string>();

  for (const receipt of receipts) {
    const cap = receipt.cap as CapabilityURN;

    // Add produced resource from state_delta or lineage field
    const producedUrn =
      receipt.lineage?.produced_resource ?? receipt.state_delta?.resource;

    if (producedUrn) {
      const existing = nodes.get(producedUrn);
      if (!existing) {
        nodes.set(producedUrn, {
          resource: producedUrn as `urn:stoa:res:${string}`,
          produced_by: cap,
          ts: receipt.ts,
        });
      }
    }

    // Add consumed resources
    const consumed = receipt.lineage?.consumed_resources ?? [];
    for (const consumedUrn of consumed) {
      const node = nodes.get(consumedUrn);
      if (!node) {
        nodes.set(consumedUrn, {
          resource: consumedUrn as `urn:stoa:res:${string}`,
          consumed_by: [cap],
          ts: receipt.ts,
        });
      } else {
        // Add this cap to consumed_by list if not already present
        if (!node.consumed_by) {
          node.consumed_by = [cap];
        } else if (!node.consumed_by.includes(cap)) {
          node.consumed_by.push(cap);
        }
      }

      // Add edge: consumed resource → produced resource (if both exist)
      if (producedUrn) {
        const edgeKey = `${consumedUrn}|${producedUrn}|${cap}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({
            from: consumedUrn,
            to: producedUrn,
            via: cap,
          });
        }
      }
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
  };
}

// ---------------------------------------------------------------------------
// Graph utilities
// ---------------------------------------------------------------------------

/**
 * Find all ancestors of a resource in the lineage graph.
 * Useful for "what data went into producing this resource?"
 */
export function findAncestors(
  resourceUrn: string,
  graph: LineageGraph
): string[] {
  const ancestors = new Set<string>();
  const queue = [resourceUrn];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    for (const edge of graph.edges) {
      if (edge.to === current && !ancestors.has(edge.from)) {
        ancestors.add(edge.from);
        queue.push(edge.from);
      }
    }
  }

  return Array.from(ancestors);
}

/**
 * Find all descendants of a resource in the lineage graph.
 * Useful for "what was produced using this resource?"
 */
export function findDescendants(
  resourceUrn: string,
  graph: LineageGraph
): string[] {
  const descendants = new Set<string>();
  const queue = [resourceUrn];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    for (const edge of graph.edges) {
      if (edge.from === current && !descendants.has(edge.to)) {
        descendants.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  return Array.from(descendants);
}

/**
 * Export the lineage graph as a DOT format string (for Graphviz).
 */
export function toDot(graph: LineageGraph): string {
  const lines: string[] = ["digraph stoa_lineage {", '  rankdir="LR";'];

  for (const node of graph.nodes) {
    const label = node.resource.replace(/^urn:stoa:res:/, "");
    const producedBy = node.produced_by ? `\\nvia: ${node.produced_by}` : "";
    lines.push(`  "${node.resource}" [label="${label}${producedBy}"];`);
  }

  for (const edge of graph.edges) {
    const capLabel = edge.via.replace(/^urn:stoa:cap:/, "");
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${capLabel}"];`);
  }

  lines.push("}");
  return lines.join("\n");
}
