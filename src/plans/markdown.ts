import type { Plan, PlanItem, Stop } from "./schema.js";
import { nextStop } from "./stops.js";

const box: Record<PlanItem["status"], string> = {
  todo: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  skipped: "[-]",
};
const stopBox: Record<Stop["status"], string> = { todo: "[ ]", done: "[x]", skipped: "[-]" };

/** Degrees to four decimals, about 10 m on an Earth-sized body, with no "-0.0000". */
const deg = (v: number) => (Math.abs(v) < 0.00005 ? 0 : v).toFixed(4);

export function planToMarkdown(plan: Plan): string {
  const done = plan.items.filter((i) => i.status === "done" || i.status === "skipped").length;
  const out = [
    `# ${plan.name}`,
    "",
    `Plan \`${plan.id}\` · updated ${plan.updated_at} · ${done}/${plan.items.length} done`,
    "",
  ];
  if (plan.repeat) out.push(`Repeating loop · lap ${plan.lap ?? 1}`, "");
  if (plan.profit_per_hour !== undefined) {
    const sustained = plan.repeat ? " (sustained)" : "";
    out.push(`Planned ${plan.profit_per_hour.toLocaleString("en-US")} cr/h${sustained}`, "");
  }
  if (plan.prices_at) out.push(`Prices from market data as old as ${plan.prices_at}`, "");
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
    out.push("## Stops", "");
    const next = nextStop(plan)?.index;
    plan.stops.forEach((s, n) => {
      const at = s.position ? `(${deg(s.position.latitude)}, ${deg(s.position.longitude)})` : null;
      // With the body it is on; a stop loaded without one still shows its coordinates.
      const body = [s.body, at].filter(Boolean).join(" ") || undefined;
      const place = [s.system, body, s.station].filter(Boolean).join(" — ");
      const kind = s.kind ? `**${s.kind}** ` : "";
      const mark = n === next ? " ← next" : "";
      out.push(`${n + 1}. ${stopBox[s.status]} ${kind}${place}: ${s.purpose}${mark}`);
      for (const c of s.cargo ?? []) {
        const price = c.price !== undefined ? ` at ${c.price.toLocaleString("en-US")} cr` : "";
        const mission = c.mission_id !== undefined ? ` (mission ${c.mission_id})` : "";
        out.push(
          `   - ${c.action === "buy" ? "Buy" : "Sell"} ${c.amount} t ${c.commodity}${price}${mission}`,
        );
      }
      if (s.notes) out.push(`   - Notes: ${s.notes}`);
    });
    out.push("");
  }
  if (plan.route) {
    out.push("## Route", "");
    plan.route.stops.forEach((s, n) => out.push(`${n + 1}. ${s}`));
    const r = plan.route;
    const kind = r.plotted ? "plotted" : "estimate";
    out.push(
      "",
      `From ${r.from}; ${kind}. Total ${r.total_min} min, computed ${r.computed_at}`,
      "",
    );
  }
  return out.join("\n");
}
