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

export const StopSchema = z.object({
  system: z.string().min(1),
  station: z.string().optional(),
  purpose: z.string().min(1),
});

export const PlanInputSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "id must be lowercase letters, digits and dashes"),
  name: z.string().min(1),
  target_build: z.unknown().optional(),
  items: z.array(PlanItemSchema).default([]),
  stops: z.array(StopSchema).default([]),
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
export type Stop = z.infer<typeof StopSchema>;
export type PlanInput = z.input<typeof PlanInputSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanFile = z.infer<typeof PlanFileSchema>;
