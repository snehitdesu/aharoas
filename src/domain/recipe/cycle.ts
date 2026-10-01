/**
 * Recipe cycle detection.
 *
 * Recipes are recursive: a recipe line can reference another recipe as a
 * sub-recipe. The database cannot express "no cycles", so the domain layer
 * must reject them. A cycle like A -> B -> C -> A would cause infinite
 * recursion during recipe explosion / costing.
 *
 * `edges` maps a recipeId to the set of sub-recipe ids it directly references.
 */
export type RecipeGraph = Map<string, Set<string>>;

export class RecipeCycleError extends Error {
  constructor(public readonly path: string[]) {
    super(`Recipe cycle detected: ${path.join(" -> ")}`);
    this.name = "RecipeCycleError";
  }
}

/**
 * Returns the cycle path if adding `childId` as a sub-recipe of `parentId`
 * would create a cycle in the existing graph, otherwise null.
 * A self-reference (parent === child) is always a cycle.
 */
export function findCycleOnAdd(
  graph: RecipeGraph,
  parentId: string,
  childId: string
): string[] | null {
  if (parentId === childId) return [parentId, childId];
  // If childId can already reach parentId, adding parent->child closes a loop.
  const path = findPath(graph, childId, parentId);
  return path ? [parentId, ...path] : null;
}

/** Depth-first search for a path from `start` to `target`. */
function findPath(graph: RecipeGraph, start: string, target: string): string[] | null {
  const stack: Array<{ node: string; trail: string[] }> = [{ node: start, trail: [start] }];
  const visited = new Set<string>();
  while (stack.length) {
    const { node, trail } = stack.pop()!;
    if (node === target) return trail;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of graph.get(node) ?? []) {
      stack.push({ node: next, trail: [...trail, next] });
    }
  }
  return null;
}

/**
 * Validates that an entire graph is acyclic. Throws RecipeCycleError on the
 * first cycle found. Used when importing/seeding recipes in bulk.
 */
export function assertAcyclic(graph: RecipeGraph): void {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const trail: string[] = [];

  const visit = (node: string): void => {
    color.set(node, GRAY);
    trail.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const start = trail.indexOf(next);
        throw new RecipeCycleError([...trail.slice(start), next]);
      }
      if (c === WHITE) visit(next);
    }
    trail.pop();
    color.set(node, BLACK);
  };

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
}

/** Convenience builder from flat (parent, child) edge pairs. */
export function buildGraph(edges: Array<[string, string]>): RecipeGraph {
  const g: RecipeGraph = new Map();
  for (const [parent, child] of edges) {
    if (!g.has(parent)) g.set(parent, new Set());
    g.get(parent)!.add(child);
    if (!g.has(child)) g.set(child, new Set());
  }
  return g;
}
