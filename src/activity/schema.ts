import { z } from "zod";

export const ActivityKind = z.enum([
  "exobiology",
  "exploration",
  "massacre",
  "missions",
  "hauling",
  "trading",
  "mining",
  "engineering",
  "combat",
  "other",
]);

export const MAX_SUMMARY = 500;

export const ActivityInputSchema = z.object({
  kind: ActivityKind,
  summary: z.string().trim().min(1).max(MAX_SUMMARY),
  plan_id: z.string().min(1).optional(),
});

export const ActivitySchema = ActivityInputSchema.extend({
  updated_at: z.string(),
});

// The file is the note itself, with a version like plans.json and preferences.json.
export const ActivityFileSchema = ActivitySchema.extend({ version: z.literal(1) });

export type ActivityInput = z.input<typeof ActivityInputSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
