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
  "gather",
  "pioneer",
  "bartender",
  "other",
]);
export const StopStatus = z.enum(["todo", "done", "skipped"]);

// What a build stop's actions are judged by (ED Chat's build panel reads them from the journal).
export const ActionKind = z.enum([
  // At an outfitting station
  "buy_module",
  "retrieve_module",
  "fetch_module",
  "store_module",
  "sell_module",
  "move_module",
  "buy_ship",
  "transfer_ship",
  "swap_ship",
  "unlock_tech",
  // At an engineer
  "unlock_engineer",
  "engineer",
  "experimental",
  // At a material trader, or anywhere
  "trade_material",
  "collect_material",
  "synthesis",
  // On foot
  "buy_suit",
  "buy_weapon",
  "upgrade_suit",
  "upgrade_weapon",
  "modify_suit",
  "modify_weapon",
  "trade_resource",
  "buy_resource",
  "collect_resource",
]);
export const ActionStatus = z.enum(["todo", "done", "skipped"]);

const count = z.number().int().positive();

export const NeedsSchema = z.object({
  materials: z
    .array(
      z.object({
        name: z.string().min(1),
        symbol: z.string().optional(),
        kind: z
          .string()
          .optional()
          .describe("Raw, Manufactured or Encoded; on foot Item, Component or Data"),
        grade: z.number().int().optional(),
        trade_group: z.string().optional(),
        count,
      }),
    )
    .optional(),
  credits: z.number().min(0).optional(),
});

// An event the panel counted for an action: its timestamp, name and n, its place (from 0) among
// the events with that name and timestamp in the journal; role and amount say what it was used for.
export const DoneBySchema = z.object({
  at: z.string().min(1).describe("The event's timestamp"),
  event: z.string().min(1),
  n: z.number().int().min(0),
  role: z.string().min(1),
  amount: z.number().int().positive().optional(),
});

const grade = z.number().int().min(1).max(5);
const id = z.number().int();
const materialCount = z.object({ material: z.string().min(1), count });

export const ActionSchema = z.object({
  id: z.string().min(1),
  kind: ActionKind,
  label: z.string().min(1).describe('What to do, e.g. "Roll FSD Increased Range to G5"'),
  status: ActionStatus.default("todo"),
  done_by: z.array(DoneBySchema).optional(),
  // On foot: a plan-local key shared by a buy and the later actions for that suit or weapon.
  gear: z.string().min(1).optional(),
  needs: NeedsSchema.optional(),
  // One roll's materials for each grade, "1" to "5", for an engineer action.
  needs_by_grade: z.record(z.string().regex(/^[1-5]$/, "a grade, 1 to 5"), NeedsSchema).optional(),
  // What the action is judged by; each kind uses some.
  module: z.string().min(1).optional(),
  slot: z.string().min(1).optional(),
  storage_slot: z.number().int().min(0).optional(),
  blueprint: z.string().min(1).optional(),
  grade: grade.optional(),
  experimental: z.string().min(1).optional(),
  engineer: z.string().min(1).optional(),
  ship: z.string().min(1).optional(),
  ship_id: id.optional(),
  broker: z.string().min(1).optional(),
  item: z.string().min(1).optional(),
  recipe: z.string().min(1).optional(),
  paid: materialCount.optional(),
  received: materialCount.optional(),
  material: z.string().min(1).optional(),
  count: count.optional(),
  suit: z.string().min(1).optional(),
  suit_id: id.optional(),
  weapon: z.string().min(1).optional(),
  weapon_id: id.optional(),
  modification: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  notes: z.string().optional(),
});

export const BuildSchema = z.object({
  target: z.enum(["ship", "suit_loadout"]),
  scope: z.enum(["full", "upgrade"]),
  ship: z.string().min(1).optional().describe("Journal ship type, e.g. python_nx"),
  ship_id: id.optional().describe("Journal ShipID; set after a hull purchase"),
  loadout_id: id.optional().describe("On foot: the suit loadout's LoadoutID"),
  started_at: z
    .string()
    .optional()
    .describe("ISO time; actions count journal events after it (created_at when missing)"),
  summary: z.string().optional().describe("One line of the target"),
  rolls_per_grade: z
    .array(z.number().int().min(0))
    .length(5)
    .optional()
    .describe("Rolls for grades 1 to 5; [1, 2, 3, 4, 5] when missing"),
});

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
  // What to do at a build stop, in the order it must be done.
  actions: z.array(ActionSchema).optional(),
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
  // For a build plan: what it builds and for which ship or suit loadout.
  build: BuildSchema.optional(),
  items: z.array(PlanItemSchema).default([]),
  stops: z.array(StopSchema).default([]),
  route: PlanRouteSchema.optional(),
  // A loop, such as one saved by trade_loops: when every stop is done or skipped, each goes back
  // to todo and lap goes up by one.
  repeat: z.boolean().optional(),
  lap: z.number().int().min(1).optional().describe("The lap under way; missing means 1"),
  // For a saved trade plan: the ISO time of the oldest market data its planned prices come from.
  prices_at: z.string().optional().describe("ISO time of the oldest market data behind the prices"),
  // For a saved trade plan: the profit an hour that trade_route or trade_loops worked out (for a
  // loop, the sustained rate over a session), so a panel can compare the rate made with the plan's.
  // Zod 4's int() also refuses NaN and Infinity.
  profit_per_hour: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Planned profit, in whole credits an hour"),
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
export type Action = z.infer<typeof ActionSchema>;
export type ActionInput = z.input<typeof ActionSchema>;
export type DoneBy = z.infer<typeof DoneBySchema>;
export type Needs = z.infer<typeof NeedsSchema>;
export type Build = z.infer<typeof BuildSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
export type PlanRoute = z.infer<typeof PlanRouteSchema>;
export type Stop = z.infer<typeof StopSchema>;
export type PlanStopInput = z.input<typeof StopSchema>;
export type PlanInput = z.input<typeof PlanInputSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanFile = z.infer<typeof PlanFileSchema>;
