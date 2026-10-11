import type { Plan, PlanItem } from "./schema.js";

const box: Record<PlanItem["status"], string> = {
  todo: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  skipped: "[-]",
};

export function planToMarkdown(plan: Plan): string {
  const done = plan.items.filter((i) => i.status === "done" || i.status === "skipped").length;
  const out = [
    `# ${plan.name}`,
    "",
    `Plan \`${plan.id}\` · updated ${plan.updated_at} · ${done}/${plan.items.length} done`,
    "",
  ];
  if (plan.notes) out.push(plan.notes, "");
  if (plan.items.length) {
    out.push("## Items", "");
    for (const i of plan.items) {
      const where = [
        i.station ? `at ${i.station}` : undefined,
        i.engineer ? `engineer ${i.engineer}` : undefined,
      ].filter(Boolean);
      out.push(
        `- ${box[i.status]} **${i.kind}** ${i.description}${where.length ? ` — ${where.join(", ")}` : ""}`,
      );
      if (i.materials?.length) {
        out.push(`  - Materials: ${i.materials.map((m) => `${m.count}× ${m.name}`).join(", ")}`);
      }
      if (i.notes) out.push(`  - Notes: ${i.notes}`);
    }
    out.push("");
  }
  if (plan.stops.length) {
    out.push("## Route", "");
    plan.stops.forEach((s, n) => {
      out.push(`${n + 1}. ${s.system}${s.station ? ` — ${s.station}` : ""}: ${s.purpose}`);
    });
    out.push("");
  }
  return out.join("\n");
}
