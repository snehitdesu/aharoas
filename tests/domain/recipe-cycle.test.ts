import { describe, it, expect } from "vitest";
import { buildGraph, findCycleOnAdd, assertAcyclic, RecipeCycleError } from "../../src/domain/recipe/cycle";

describe("Recipe cycle detection", () => {
  it("allows a valid nested chain A -> B -> C", () => {
    const g = buildGraph([
      ["A", "B"],
      ["B", "C"],
    ]);
    expect(() => assertAcyclic(g)).not.toThrow();
  });

  it("rejects a direct self-reference", () => {
    const g = buildGraph([]);
    expect(findCycleOnAdd(g, "A", "A")).toEqual(["A", "A"]);
  });

  it("detects that adding C -> A closes the loop A -> B -> C -> A", () => {
    const g = buildGraph([
      ["A", "B"],
      ["B", "C"],
    ]);
    const cycle = findCycleOnAdd(g, "C", "A");
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe("C");
    expect(cycle![cycle!.length - 1]).toBe("C");
  });

  it("allows adding a safe edge that does not create a cycle", () => {
    const g = buildGraph([
      ["A", "B"],
      ["A", "C"],
    ]);
    expect(findCycleOnAdd(g, "B", "C")).toBeNull();
  });

  it("assertAcyclic throws on an existing cycle", () => {
    const g = buildGraph([
      ["A", "B"],
      ["B", "C"],
      ["C", "A"],
    ]);
    expect(() => assertAcyclic(g)).toThrow(RecipeCycleError);
  });

  it("supports deep nesting (12+ levels) without false positives", () => {
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 14; i++) edges.push([`R${i}`, `R${i + 1}`]);
    const g = buildGraph(edges);
    expect(() => assertAcyclic(g)).not.toThrow();
    // Closing the deep chain must be caught.
    expect(findCycleOnAdd(g, "R14", "R0")).not.toBeNull();
  });
});
