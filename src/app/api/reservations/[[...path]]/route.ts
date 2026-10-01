import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, outletQuery } from "@/server/api/router";
import { ReservationStatus } from "@/constants/enums";
import {
  listReservations, createReservation, confirmReservation, cancelReservation, noShowReservation, completeReservation, seatReservation, assignTable,
  listWaitlist, createWaitlistEntry, markWaitlistArrived, markWaitlistLeft, cancelWaitlistEntry, promoteWaitlistEntry,
} from "@/server/services/reservations";

export const runtime = "nodejs";

const listQ = outletQuery.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: ReservationStatus.zod.optional(), take: z.coerce.number().int().positive().max(200).optional(), cursor: z.string().optional() });
const table = z.object({ tableId: z.string().min(1) });

export const { GET, POST } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listReservations(prisma, ctx, listQ.parse(query)) },
  { method: "POST", path: "", handler: ({ ctx, body }) => createReservation(ctx, body as never) },
  { method: "POST", path: ":id/confirm", handler: ({ ctx, params }) => confirmReservation(ctx, params.id) },
  { method: "POST", path: ":id/cancel", handler: ({ ctx, params }) => cancelReservation(ctx, params.id) },
  { method: "POST", path: ":id/no-show", handler: ({ ctx, params }) => noShowReservation(ctx, params.id) },
  { method: "POST", path: ":id/seat", handler: ({ ctx, params, body }) => seatReservation(ctx, params.id, z.object({ tableId: z.string().optional() }).parse(body).tableId) },
  { method: "POST", path: ":id/complete", handler: ({ ctx, params }) => completeReservation(ctx, params.id) },
  { method: "POST", path: ":id/assign-table", handler: ({ ctx, params, body }) => assignTable(ctx, params.id, table.parse(body).tableId) },
  { method: "GET", path: "waitlist", handler: ({ ctx, query }) => listWaitlist(prisma, ctx, outletQuery.parse(query).outletId) },
  { method: "POST", path: "waitlist", handler: ({ ctx, body }) => createWaitlistEntry(ctx, body as never) },
  { method: "POST", path: "waitlist/:id/arrived", handler: ({ ctx, params }) => markWaitlistArrived(ctx, params.id) },
  { method: "POST", path: "waitlist/:id/left", handler: ({ ctx, params }) => markWaitlistLeft(ctx, params.id) },
  { method: "POST", path: "waitlist/:id/cancel", handler: ({ ctx, params }) => cancelWaitlistEntry(ctx, params.id) },
  { method: "POST", path: "waitlist/:id/promote", handler: ({ ctx, params, body }) => promoteWaitlistEntry(ctx, params.id, table.parse(body).tableId) },
]);
