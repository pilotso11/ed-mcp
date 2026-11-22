import { z } from "zod";

export const ItemKind = z.enum([
  "buy",
  "engineer",
  "experimental",
  "unlock_engineer",
  "gather",
  "trade",
  "refit",
]);
export const ItemStatus = z.enum(["todo", "in_progress", "done", "skipped"]);

export const PlanItemSchema = z.object({
  id: z.string().min(1),
  kind: ItemKind,
  description: z.string().min(1),
  status: ItemStatus.default("todo"),
  station: z.string().optional(),
  engineer: z.string().optional(),
  materials: z
    .array(z.object({ name: z.string().min(1), count: z.number().int().positive() }))
    .optional(),
  notes: z.string().optional(),
});

export const StopKind = z.enum([
  "shop",
  "trader",
  "engineer",
  "exobiology",
  "exploration",
  "combat",
  "mission",
  "hand_in",
  "trade",
  "mining",
  "fuel",
  "other",
]);
export const StopStatus = z.enum(["todo", "done", "skipped"]);

// Every field added after the first release is optional or has a default, so old files load.
export const StopSchema = z.object({
  system: z.string().min(1),
  // Older files can hold station "", which named nothing; it reads as no station.
  station: z
    .string()
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  body: z.string().min(1).optional(),
  // A place on the body's surface, in degrees, such as a bookmark ED Chat saved from Status.json.
  // It goes with `body`; a stop without one still loads, and shows the coordinates alone.
  position: z
    .object({
      latitude: z.number().min(-90).max(90).describe("Degrees"),
      longitude: z.number().min(-180).max(180).describe("Degrees"),
    })
    .describe("A place on the body\'s surface; give the body too")
    .optional(),
  purpose: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: StopKind.optional(),
  after: z.array(z.string().min(1)).optional(),
  status: StopStatus.default("todo"),
  notes: z.string().optional(),
});

export const PlanRouteSchema = z.object({
  computed_at: z.string(),
  from: z.string(),
  stops: z.array(z.string()),
  total_min: z.number(),
  plotted: z.boolean(),
  // For each entry of stops, the indexes in the plan's stops that it visits. Names alone do not
  // map back: an engineer stop takes the engineer's name, and repeated names get -2, -3.
  // Optional, so routes saved before it load.
  stop_indexes: z.array(z.array(z.number().int().min(0))).optional(),
});

// Also bounds the activity note's plan_id, which keeps activity.json small.
export const PlanId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "id must be lowercase letters, digits and dashes");

export const PlanInputSchema = z.object({
  id: PlanId,
  name: z.string().min(1),
  target_build: z.unknown().optional(),
  items: z.array(PlanItemSchema).default([]),
  stops: z.array(StopSchema).default([]),
  route: PlanRouteSchema.optional(),
  notes: z.string().optional(),
});

export const PlanSchema = PlanInputSchema.extend({
  created_at: z.string(),
  updated_at: z.string(),
});

export const PlanFileSchema = z.object({
  version: z.literal(1),
  plans: z.array(PlanSchema),
});

export type PlanItem = z.infer<typeof PlanItemSchema>;
export type PlanRoute = z.infer<typeof PlanRouteSchema>;
export type Stop = z.infer<typeof StopSchema>;
export type StopInput = z.input<typeof StopSchema>;
export type PlanInput = z.input<typeof PlanInputSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanFile = z.infer<typeof PlanFileSchema>;
