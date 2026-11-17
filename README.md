# Harvester & Scavenger

Add harvest and loot interactions to tokens, with D&D 5e checks, automatic item rewards, roll tables, and optional macros.

**Requires:** Foundry VTT 14, D&D 5e 6.x, libWrapper, and socketlib.

## Install

In **Install Module**, paste this manifest URL, then enable the module and its dependencies:

```text
https://github.com/PainfulVitality/harvester-scavenger/releases/latest/download/module.json
```

## Use

Right-click an actor and choose **Configure Harvest Template**, or open a token’s **Harvest Settings**. Enable harvesting, choose a check, and add rewards. Double-click the placed token to harvest or loot it. An active GM is required.

Code: [MIT](LICENSE). Sounds: [CC0 from Freesound.org](assets/LICENSE.md).

Revealed item rewards and item results in revealed roll tables have a **Display in chat** button. It posts a full D&D item card without using the item or consuming resources. Unknown rewards remain hidden.

In **Configure Settings → Harvester & Scavenger**, set **Success Message** and **Failure Message** to customize the text inside the harvest/loot window. Empty values preserve the default messages. Existing chat receipt wording is unchanged.

[Token Nameplates](https://foundryvtt.com/packages/token-nameplates) is optional. When enabled, six world settings customize available, failed, and depleted labels separately for Harvest and Loot wording, including “Harvested” and “Looted”. The module runs without it.

With **Enable harvest only at 0 hit points or fewer** enabled, normal sheet access and token behavior continue above 0 HP. At 0 HP or below, double-click opens the harvest/loot window. The GM's right-click HUD retains the configuration icon in either state; GM Alt-double-click opens the underlying sheet.

For unusually large configurations, limits are 20 thresholds, 100 entries per reward list, 500 references overall, 200 table draws per attempt, and 500 inventory documents per delivery. Invalid definitions are rejected before rewards are applied.
