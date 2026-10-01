import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { listNotifications, unreadCount, markNotificationRead, markAllRead } from "@/server/services/notifications";

export const runtime = "nodejs";

const listQ = z.object({
  onlyUnread: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  outletId: z.string().optional(),
  take: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
});

// Always scoped to the caller: their own notifications + broadcasts for their org/outlets.
export const { GET, POST } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listNotifications(prisma, ctx, listQ.parse(query)) },
  { method: "GET", path: "unread-count", handler: async ({ ctx }) => ({ unread: await unreadCount(prisma, ctx) }) },
  { method: "POST", path: "read-all", handler: async ({ ctx }) => ({ updated: await markAllRead(ctx) }) },
  { method: "POST", path: ":id/read", handler: ({ ctx, params }) => markNotificationRead(ctx, params.id) },
]);
