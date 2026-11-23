// The public library entry, `ed-mcp/journal`: the journal, plan and activity code that the
// MCP tools use, for other programs such as ED Chat. Breaking changes here need a major version.
import { defaultDirs, loadConfig } from "../config.js";
import { ActivityStore } from "../activity/store.js";
import { JournalReader } from "../journal/reader.js";
import { JournalService, KEPT_EVENTS } from "../journal/service.js";
import { PlanStore } from "../plans/store.js";
import { fileOptions } from "../files.js";

export { JournalService, KEPT_EVENTS, type JournalStatus } from "../journal/service.js";
export type { JournalEvent } from "../journal/reader.js";
export type { JournalState, Mission, StoredModule } from "../journal/state.js";
export { normaliseModule } from "../journal/modules.js";
export {
  planTrades,
  tradeRate,
  type MatInfo,
  type NeedLine,
  type Rate,
  type Trade,
} from "../materials/trade.js";
export {
  exobiology,
  exploration,
  systemAddress,
  type BodySignal,
  type ExobiologyBody,
  type Exploration,
  type ExplorationBody,
  type Species,
} from "../journal/bodies.js";
export { massacre, type MassacreGroup, type MassacreMission } from "../journal/massacre.js";
export {
  bodyValue,
  colonyRange,
  genusName,
  genusOf,
  genusSpecies,
  genusValue,
  speciesValue,
  surfaceDistance,
  type BodyValueOptions,
} from "../journal/values.js";
export {
  atmosphereKey,
  conditionsFromScan,
  predictSpecies,
  scanConditions,
  starCode,
  volcanismKey,
  type BioConditions,
  type SpeciesPrediction,
} from "../journal/predict.js";
export { regionAt, systemRegion } from "../journal/regions.js";
export { ActivityStore } from "../activity/store.js";
export type { Activity } from "../activity/schema.js";
export { PlanStore } from "../plans/store.js";
export { nextStop, visitOrder, type NextStop } from "../plans/stops.js";
export type {
  Action,
  ActionInput,
  Build,
  DoneBy,
  Needs,
  Plan,
  PlanRoute,
  Stop,
  PlanStopInput,
} from "../plans/schema.js";
export type { ActionPatch } from "../plans/store.js";
// The journal events that finish each trade, mission and station action kind.
export { ACTION_EVENTS } from "../actionEvents.js";

export interface Stores {
  journal: JournalService;
  plans: PlanStore;
  activity: ActivityStore;
}

/**
 * The journal, plans and activity note, opened the way the ed-mcp server opens them, so both
 * share the files and the locks. Pass the server's environment: ED_JOURNAL_DIR and
 * ED_MCP_SYNC_DIR are read; passwords and API keys are not needed and not read.
 * `keep` adds journal events to the ones the service keeps for its own tools.
 */
export function openStores(
  env: { ED_JOURNAL_DIR?: string; ED_MCP_SYNC_DIR?: string },
  opts: { keep?: Iterable<string> } = {},
): Stores {
  const config = loadConfig(
    { ED_JOURNAL_DIR: env.ED_JOURNAL_DIR, ED_MCP_SYNC_DIR: env.ED_MCP_SYNC_DIR },
    defaultDirs(),
  );
  const { guardFor, lockFor } = fileOptions(config);
  return {
    journal: new JournalService(config.journalDir, {
      reader: opts.keep
        ? new JournalReader({ keep: new Set([...KEPT_EVENTS, ...opts.keep]) })
        : undefined,
    }),
    plans: new PlanStore(config.plansFile, undefined, {
      lockDir: lockFor(config.plansFile),
      guard: guardFor(config.plansFile),
      markdownDir: config.plansMarkdownDir,
    }),
    activity: new ActivityStore(config.activityFile, undefined, {
      lockDir: lockFor(config.activityFile),
      guard: guardFor(config.activityFile),
    }),
  };
}
