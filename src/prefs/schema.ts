import { z } from "zod";
import { UserError } from "../errors.js";

export const Mode = z.enum(["soft", "hard", "off"]);
export const TypeRule = z.enum(["allow", "avoid", "exclude"]);
export const PadPref = z.enum(["auto", "S", "M", "L", "none"]);

const Arrival = z.object({ value: z.number().positive(), mode: Mode });
const Discounts = z.object({
  enabled: z.boolean(),
  min_pct: z.number().min(0).max(100),
  max_extra_ly: z.number().min(0),
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
  discounts: Discounts,
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
    discounts: Discounts.partial().strict().optional(),
  })
  .strict();
export type PrefsPatch = z.infer<typeof PrefsPatchSchema>;

export const DEFAULT_PREFS: Prefs = {
  version: 1,
  stations: {
    max_arrival_ls: { value: 1000, mode: "soft" },
    planetary: "avoid",
    fleet_carriers: "exclude",
    megaships: "allow",
    min_pad: "auto",
  },
  discounts: { enabled: true, min_pct: 10, max_extra_ly: 30 },
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
  discounts: { enabled: false, min_pct: 10, max_extra_ly: 30 },
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
    discounts: { ...base.discounts, ...(patch.discounts ?? {}) },
  });
}
