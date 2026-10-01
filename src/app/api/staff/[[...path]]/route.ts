import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, outletQuery } from "@/server/api/router";
import { TaskStatus } from "@/constants/enums";
import {
  listStaff, createStaff, assignMembership, revokeMembership, setUserActive,
  checkIn, checkOut, correctAttendance, listShifts, createShift, requestLeave, approveLeave, rejectLeave,
  listTasks, createTask, transitionTask, cancelTask,
} from "@/server/services/staff";
import { roleMatrix, listAttendance, listLeave } from "@/server/services/adminQueries";

export const runtime = "nodejs";

const page = z.object({ take: z.coerce.number().int().positive().max(200).optional(), cursor: z.string().optional() });

export const { GET, POST, PATCH, DELETE } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listStaff(prisma, ctx, page.extend({ outletId: z.string().optional() }).parse(query)) },
  { method: "POST", path: "", handler: ({ ctx, body }) => createStaff(ctx, body as never) },
  { method: "GET", path: "roles", handler: async ({ ctx }) => roleMatrix(ctx) },
  { method: "GET", path: "attendance", handler: ({ ctx, query }) => listAttendance(prisma, ctx, query) },
  { method: "GET", path: "leave", handler: ({ ctx, query }) => listLeave(prisma, ctx, query) },
  { method: "POST", path: "memberships", handler: ({ ctx, body }) => assignMembership(ctx, body as never) },
  { method: "DELETE", path: "memberships/:id", handler: ({ ctx, params }) => revokeMembership(ctx, params.id) },
  { method: "POST", path: "users/:id/active", handler: ({ ctx, params, body }) => setUserActive(ctx, params.id, z.object({ active: z.boolean() }).parse(body).active) },
  { method: "POST", path: "attendance/check-in", handler: ({ ctx, body }) => checkIn(ctx, body as never) },
  { method: "POST", path: "attendance/:id/check-out", handler: ({ ctx, params }) => checkOut(ctx, params.id) },
  { method: "PATCH", path: "attendance/:id", handler: ({ ctx, params, body }) => correctAttendance(ctx, params.id, body as never) },
  { method: "GET", path: "shifts", handler: ({ ctx, query }) => listShifts(prisma, ctx, outletQuery.parse(query).outletId) },
  { method: "POST", path: "shifts", handler: ({ ctx, body }) => createShift(ctx, body as never) },
  { method: "POST", path: "leave", handler: ({ ctx, body }) => requestLeave(ctx, body as never) },
  { method: "POST", path: "leave/:id/approve", handler: ({ ctx, params }) => approveLeave(ctx, params.id) },
  { method: "POST", path: "leave/:id/reject", handler: ({ ctx, params }) => rejectLeave(ctx, params.id) },
  { method: "GET", path: "tasks", handler: ({ ctx, query }) => listTasks(prisma, ctx, page.extend({ outletId: z.string(), status: TaskStatus.zod.optional(), assignedToId: z.string().optional() }).parse(query)) },
  { method: "POST", path: "tasks", handler: ({ ctx, body }) => createTask(ctx, body as never) },
  { method: "POST", path: "tasks/:id/transition", handler: ({ ctx, params, body }) => transitionTask(ctx, params.id, z.object({ to: z.enum(["OPEN", "IN_PROGRESS", "DONE", "VERIFIED"]) }).parse(body).to) },
  { method: "POST", path: "tasks/:id/cancel", handler: ({ ctx, params }) => cancelTask(ctx, params.id) },
]);
