import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import {
  listMenu, listMenuCategories, createMenuCategory, updateMenuCategory, createMenuItem, updateMenuItem, setMenuItemAvailability,
  addVariant, updateVariant, createModifierGroup, updateModifierGroup, addModifierOption, updateModifierOption, attachModifierGroup, detachModifierGroup, setOutletMenuItem,
} from "@/server/services/menu";
import { listModifierGroups } from "@/server/services/adminQueries";

export const runtime = "nodejs";

const menuQuery = z.object({ activeOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"), categoryId: z.string().optional(), outletId: z.string().optional() });

export const { GET, POST, PATCH, DELETE } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listMenu(prisma, ctx, menuQuery.parse(query)) },
  { method: "GET", path: "categories", handler: ({ ctx }) => listMenuCategories(prisma, ctx) },
  { method: "POST", path: "categories", handler: ({ ctx, body }) => createMenuCategory(ctx, body as never) },
  { method: "PATCH", path: "categories/:id", handler: ({ ctx, params, body }) => updateMenuCategory(ctx, params.id, body as never) },
  { method: "POST", path: "items", handler: ({ ctx, body }) => createMenuItem(ctx, body as never) },
  { method: "PATCH", path: "items/:id", handler: ({ ctx, params, body }) => updateMenuItem(ctx, params.id, body as never) },
  { method: "POST", path: "items/:id/availability", handler: ({ ctx, params, body }) => setMenuItemAvailability(ctx, params.id, body as never) },
  { method: "POST", path: "items/:id/variants", handler: ({ ctx, params, body }) => addVariant(ctx, { ...(body as object), menuItemId: params.id } as never) },
  { method: "PATCH", path: "variants/:id", handler: ({ ctx, params, body }) => updateVariant(ctx, params.id, body as never) },
  { method: "GET", path: "modifier-groups", handler: ({ ctx }) => listModifierGroups(prisma, ctx) },
  { method: "POST", path: "modifier-groups", handler: ({ ctx, body }) => createModifierGroup(ctx, body as never) },
  { method: "PATCH", path: "modifier-groups/:id", handler: ({ ctx, params, body }) => updateModifierGroup(ctx, params.id, body as never) },
  { method: "POST", path: "modifier-groups/:id/options", handler: ({ ctx, params, body }) => addModifierOption(ctx, { ...(body as object), groupId: params.id } as never) },
  { method: "PATCH", path: "modifier-options/:id", handler: ({ ctx, params, body }) => updateModifierOption(ctx, params.id, body as never) },
  { method: "POST", path: "items/:id/modifier-groups/:groupId", handler: ({ ctx, params }) => attachModifierGroup(ctx, params.id, params.groupId) },
  { method: "DELETE", path: "items/:id/modifier-groups/:groupId", handler: ({ ctx, params }) => detachModifierGroup(ctx, params.id, params.groupId) },
  // Per-outlet overrides (menu.manage at that outlet)
  { method: "POST", path: "outlets/:outletId/items/:id", handler: ({ ctx, params, body }) => setOutletMenuItem(ctx, { ...(body as object), outletId: params.outletId, menuItemId: params.id } as never) },
]);
