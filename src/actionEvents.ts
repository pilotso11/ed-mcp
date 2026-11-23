/**
 * The journal events that finish each kind of trade, mission and station action at a plan's
 * stop: an action is done when one of them matches it (for a count, when the matches add up to
 * it). Every one is in the journal reader's KEPT_EVENTS. The build kinds are in ED Chat's build
 * panel spec.
 *
 * Here, apart from the plans and the journal code, so each can use it without the other. The
 * plan schema checks that every key is an action kind.
 */
export const ACTION_EVENTS = {
  buy_commodity: ["MarketBuy"],
  sell_commodity: ["MarketSell"],
  accept_mission: ["MissionAccepted"],
  complete_mission: ["MissionCompleted"],
  collect_cargo: ["CargoDepot"],
  deliver_cargo: ["CargoDepot"],
  sell_data: ["MultiSellExplorationData", "SellExplorationData", "SellOrganicData"],
  redeem_vouchers: ["RedeemVoucher"],
  refuel: ["RefuelAll", "RefuelPartial"],
  repair: ["RepairAll", "Repair"],
  restock: ["BuyAmmo"],
} as const;
