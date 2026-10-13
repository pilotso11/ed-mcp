import { z } from "zod";
import { UserError } from "../errors.js";

export const Mode = z.enum(["soft", "hard", "off"]);
export const TypeRule = z.enum(["allow", "avoid", "exclude"]);
export const PadPref = z.enum(["auto", "S", "M", "L", "none"]);

const Arrival = z.object({ value: z.number().positive(), mode: Mode });
const Supercruise = z.object({
  base_s: z.number().min(0),
  coeff: z.number().min(0),
  exponent: z.number().min(0),
  speed_factor: z.number().positive(),
});
const Occlusion = z.object({ chance: z.number().min(0).max(1), seconds: z.number().min(0) });
const NearStar = z.object({ within_ls: z.number().min(0), seconds: z.number().min(0) });
const Travel = z.object({
  jump_range_ly: z.number().positive(),
  seconds_per_jump: z.number().min(0),
  refuel_every_jumps: z.number().int().min(0),
  refuel_s: z.number().min(0),
  supercruise: Supercruise,
  occlusion: Occlusion,
  near_star: NearStar,
  dock_s: z.number().min(0),
  planetary_extra_s: z.number().min(0),
  credits_per_hour: z.number().min(0),
});

export const PrefsSchema = z.object({
  version: z.literal(1),
  stations: z.object({
    max_arrival_ls: Arrival,
    planetary: TypeRule,
    fleet_carriers: z.enum(["allow", "exclude"]),
    megaships: TypeRule,
    min_pad: PadPref,
  }),
  travel: Travel,
});
export type Prefs = z.infer<typeof PrefsSchema>;

export const PrefsPatchSchema = z
  .object({
    stations: z
      .object({
        max_arrival_ls: Arrival.partial().strict().optional(),
        planetary: TypeRule.optional(),
        fleet_carriers: z.enum(["allow", "exclude"]).optional(),
        megaships: TypeRule.optional(),
        min_pad: PadPref.optional(),
      })
      .strict()
      .optional(),
    travel: Travel.extend({
      supercruise: Supercruise.partial().strict().optional(),
      occlusion: Occlusion.partial().strict().optional(),
      near_star: NearStar.partial().strict().optional(),
    })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type PrefsPatch = z.infer<typeof PrefsPatchSchema>;

const DEFAULT_TRAVEL = {
  jump_range_ly: 30,
  seconds_per_jump: 60,
  refuel_every_jumps: 0,
  refuel_s: 120,
  supercruise: { base_s: 20, coeff: 8.9, exponent: 0.33, speed_factor: 1 },
  occlusion: { chance: 0.5, seconds: 40 },
  near_star: { within_ls: 50, seconds: 30 },
  dock_s: 60,
  planetary_extra_s: 90,
  credits_per_hour: 20_000_000,
};

export const DEFAULT_PREFS: Prefs = {
  version: 1,
  stations: {
    max_arrival_ls: { value: 1000, mode: "soft" },
    planetary: "avoid",
    fleet_carriers: "exclude",
    megaships: "allow",
    min_pad: "auto",
  },
  travel: structuredClone(DEFAULT_TRAVEL),
};

export const OFF_PREFS: Prefs = {
  version: 1,
  stations: {
    max_arrival_ls: { value: 1000, mode: "off" },
    planetary: "allow",
    fleet_carriers: "allow",
    megaships: "allow",
    min_pad: "none",
  },
  travel: structuredClone(DEFAULT_TRAVEL),
};

export function parsePatch(input: unknown): PrefsPatch {
  const r = PrefsPatchSchema.safeParse(input ?? {});
  if (!r.success) throw new UserError(`Invalid preferences: ${z.prettifyError(r.error)}`);
  return r.data;
}

export function applyPatch(base: Prefs, patch: PrefsPatch): Prefs {
  const s = patch.stations ?? {};
  return PrefsSchema.parse({
    version: 1,
    stations: {
      ...base.stations,
      ...s,
      max_arrival_ls: { ...base.stations.max_arrival_ls, ...(s.max_arrival_ls ?? {}) },
    },
    travel: {
      ...base.travel,
      ...(patch.travel ?? {}),
      supercruise: { ...base.travel.supercruise, ...(patch.travel?.supercruise ?? {}) },
      occlusion: { ...base.travel.occlusion, ...(patch.travel?.occlusion ?? {}) },
      near_star: { ...base.travel.near_star, ...(patch.travel?.near_star ?? {}) },
    },
  });
}
