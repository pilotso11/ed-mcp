import type { Needs, Plan, PlanItem, Stop } from "./schema.js";
import { nextStop } from "./stops.js";
import { cargoCover } from "./actions.js";

/** Whether the text has the number, as written or with thousands separators. */
const hasNumber = (text: string, n: number) =>
  text.includes(n.toLocaleString("en-US")) || new RegExp(`(^|[^0-9.,])${n}([^0-9]|$)`).test(text);

const box: Record<PlanItem["status"], string> = {
  todo: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  skipped: "[-]",
};
const stopBox: Record<Stop["status"], string> = { todo: "[ ]", done: "[x]", skipped: "[-]" };

/** Degrees to four decimals, about 10 m on an Earth-sized body, with no "-0.0000". */
const deg = (v: number) => (Math.abs(v) < 0.00005 ? 0 : v).toFixed(4);

const credits = (n: number) => `${n.toLocaleString("en-US")} cr`;

/** "12× Arsenic, 5,100,000 cr", or null for no needs. */
function needsText(needs: Needs | undefined): string | null {
  const parts = (needs?.materials ?? []).map((m) => `${m.count}× ${m.name}`);
  if (needs?.credits) parts.push(credits(needs.credits));
  return parts.length ? parts.join(", ") : null;
}

export function planToMarkdown(plan: Plan): string {
  const done = plan.items.filter((i) => i.status === "done" || i.status === "skipped").length;
  const actions = plan.stops.flatMap((s) => s.actions ?? []);
  const actionsDone = actions.filter((a) => a.status === "done" || a.status === "skipped").length;
  const out = [
    `# ${plan.name}`,
    "",
    [
      `Plan \`${plan.id}\``,
      `updated ${plan.updated_at}`,
      // A build plan written by build_plan has actions and no items.
      plan.items.length || !actions.length ? `${done}/${plan.items.length} done` : undefined,
      actions.length ? `${actionsDone}/${actions.length} actions done` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
  ];
  const b = plan.build;
  if (b) {
    const what = `${b.target === "ship" ? "ship" : "suit loadout"} ${b.scope === "upgrade" ? "upgrade" : "build"}`;
    const parts = [
      `Build: ${what}`,
      b.ship,
      b.ship_id !== undefined ? `ShipID ${b.ship_id}` : undefined,
      b.loadout_id !== undefined ? `LoadoutID ${b.loadout_id}` : undefined,
      b.started_at ? `from ${b.started_at}` : undefined,
    ];
    out.push(parts.filter(Boolean).join(" · "), "");
    if (b.summary) out.push(`Target: ${b.summary}`, "");
  }
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
      // A cargo row that an action covers is listed with the actions, not twice.
      const cover = cargoCover(s.cargo ?? [], s.actions ?? []);
      for (const c of (s.cargo ?? []).filter((_, k) => cover[k]! < 0)) {
        const price = c.price !== undefined ? ` at ${c.price.toLocaleString("en-US")} cr` : "";
        const mission = c.mission_id !== undefined ? ` (mission ${c.mission_id})` : "";
        out.push(
          `   - ${c.action === "buy" ? "Buy" : "Sell"} ${c.amount} t ${c.commodity}${price}${mission}`,
        );
      }
      // The cargo row each action covers, for its mission.
      const rowOf = new Map(cover.flatMap((i, k) => (i >= 0 ? [[i, s.cargo![k]!]] : [])));
      for (const [i, a] of (s.actions ?? []).entries()) {
        const shown = a.price !== undefined && hasNumber(a.label, a.price);
        const price =
          a.price !== undefined && !shown ? ` at ${a.price.toLocaleString("en-US")} cr` : "";
        const missionId = a.mission_id ?? rowOf.get(i)?.mission_id;
        // A mission action's label names its mission already.
        const commodity = a.kind === "buy_commodity" || a.kind === "sell_commodity";
        const mission = commodity && missionId !== undefined ? ` (mission ${missionId})` : "";
        out.push(`   - ${stopBox[a.status]} ${a.label}${price}${mission}`);
        const needs = needsText(a.needs);
        if (needs && a.status === "todo") out.push(`     - Needs: ${needs}`);
        if (a.notes) out.push(`     - Notes: ${a.notes}`);
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
