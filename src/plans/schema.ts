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

export const CargoSchema = z.object({
  commodity: z.string().min(1).describe("English commodity name, e.g. Gold"),
  action: z.enum(["buy", "sell"]),
  amount: z.number().int().positive().describe("Tonnes"),
  price: z.number().optional().describe("Planned unit price"),
  mission_id: z.number().int().optional(),
});

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
    .describe("A place on the body's surface; give the body too")
    .optional(),
  purpose: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: StopKind.optional(),
  after: z.array(z.string().min(1)).optional(),
  // The journal mission IDs the stop serves, for a route saved by missions_plan.
  missions: z.array(z.number().int()).optional(),
  // What to buy or sell at the stop, for a route saved by trade_route or trade_loops, so a panel
  // can check the hold against the plan. A stop that sells one load and buys the next lists the
  // sale first.
  cargo: z.array(CargoSchema).optional(),
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
  // A loop, such as one saved by trade_loops: when every stop is done or skipped, each goes back
  // to todo and lap goes up by one.
  repeat: z.boolean().optional(),
  lap: z.number().int().min(1).optional().describe("The lap under way; missing means 1"),
  // For a saved trade plan: the ISO time of the oldest market data its planned prices come from.
  prices_at: z.string().optional().describe("ISO time of the oldest market data behind the prices"),
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

export type Cargo = z.infer<typeof CargoSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
export type PlanRoute = z.infer<typeof PlanRouteSchema>;
export type Stop = z.infer<typeof StopSchema>;
export type PlanStopInput = z.input<typeof StopSchema>;
export type PlanInput = z.input<typeof PlanInputSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanFile = z.infer<typeof PlanFileSchema>;
