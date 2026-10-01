import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { assertOutletAccess } from "@/server/db/scope";
import {
  listRecipes, getRecipe, createRecipe, createRecipeVersion, updateRecipeVersion, addRecipeLine, removeRecipeLine,
  approveRecipeVersion, archiveRecipeVersion, calculateRecipeCost, menuItemCostAndMargin, describeCostLines,
} from "@/server/services/recipe";
import { num } from "@/domain/money";

export const runtime = "nodejs";

const costQuery = z.object({ outletId: z.string().min(1), quantity: z.coerce.number().positive().optional() });
const listQuery = z.object({ outputType: z.string().optional(), search: z.string().trim().max(100).optional(), take: z.coerce.number().int().positive().max(500).optional(), cursor: z.string().optional() });

export const { GET, POST, PATCH, DELETE } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listRecipes(prisma, ctx, listQuery.parse(query)) },
  { method: "POST", path: "", handler: ({ ctx, body }) => createRecipe(ctx, body as never) },
  { method: "GET", path: ":id", handler: ({ ctx, params }) => getRecipe(prisma, ctx, params.id) },
  { method: "POST", path: ":id/versions", handler: ({ ctx, params, body }) => createRecipeVersion(ctx, params.id, body as never) },
  { method: "PATCH", path: "versions/:id", handler: ({ ctx, params, body }) => updateRecipeVersion(ctx, params.id, body as never) },
  { method: "POST", path: "versions/:id/lines", handler: ({ ctx, params, body }) => addRecipeLine(ctx, params.id, body as never) },
  { method: "DELETE", path: "lines/:id", handler: ({ ctx, params }) => removeRecipeLine(ctx, params.id) },
  { method: "POST", path: "versions/:id/approve", handler: ({ ctx, params }) => approveRecipeVersion(ctx, params.id) },
  { method: "POST", path: "versions/:id/archive", handler: ({ ctx, params }) => archiveRecipeVersion(ctx, params.id) },
  {
    method: "GET", path: "versions/:id/cost",
    handler: async ({ ctx, params, query }) => {
      const q = costQuery.parse(query);
      assertOutletAccess(ctx, q.outletId);
      const c = await calculateRecipeCost(prisma, ctx, params.id, q);
      return { total: num(c.total), quantity: num(c.quantity), lines: await describeCostLines(prisma, ctx, c.lines) };
    },
  },
  {
    method: "GET", path: "menu-items/:id/margin",
    handler: async ({ ctx, params, query }) => {
      const m = await menuItemCostAndMargin(prisma, ctx, params.id, costQuery.parse(query).outletId);
      return { ...m, lines: await describeCostLines(prisma, ctx, m.lines) };
    },
  },
]);
