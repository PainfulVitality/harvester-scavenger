# Publication audit — 1.14.0

Tested on 17 November 2026. Runtime integration: Foundry VTT 14.370, D&D 5e 6.1.0, libWrapper 1.13.5.1, socketlib, and Token Nameplates 1.3.8 both disabled and enabled. Native tests used a fresh disposable world, separate GM and player browser sessions, and copied system/module installations. No campaign documents were used.

## Verification

- `python tools/test_module.py`: 124 passing tests, plus syntax checks of every runtime script.
- Native GM/player tests: creation and configuration of real actors, embedded rewards, roll tables, tokens, private module records, inventory updates, chat cards, and native D&D skill checks.
- Real player with no ownership or permission on the source actor/item: read-only preview and public item-card posting both work for revealed rewards. Revealed table-item results also post successfully.
- Secret description blocks are removed from snapshots before transmission and from shared item cards. Hidden rewards and premature inspection of a living defeated-only creature are rejected.
- Concurrency: overlapping starts, duplicate finishes, replayed or expired nonces, and different nodes delivering to the same inventory. Progress records precede delivery; retries cannot duplicate rewards after a recorded delivery failure.
- Permissions and changing state: moving away, hiding the selected token, losing ownership, reviving the source, replacing its recipe, removing a required tool, unauthorized unlocks, malformed requests, and corrupt settings/progress.
- Roll verification: skill/ability/tool modes, wrong author or speaker, wrong nonce or check, invalid/discarded d20 results, absent roll data, and nonfinite totals. Private and blind receipts retain their audience and suppress returned totals.
- Window messages: customized success and failure text appears in native player windows. Existing receipt wording remains separate.
- Token interaction regression tests: above 0 HP, native sheet permission checks and double-click behavior remain in place for players and GMs. At 0 HP or below, the module handles double-click. GM Alt-double-click retains sheet access. GM configuration HUD icon remains before and after defeat. Living tokens retain native appearance, with border restoration on revival.
- Optional nameplates: no hooks or optional API calls when missing/disabled; one wrapper when active; independent Harvest/Loot labels; safe handling of missing or failed optional refresh methods. Native Loot label changes verified.
- Release packaging: only intended runtime files, documentation, and audio are included; hidden files and unexpected file types are rejected; import targets, archive contents, checksums, and installed bytes are verified.

The successful native GM/player runs raised no browser exceptions. A Foundry 14 integration issue discovered during testing was fixed: shared cards now use the supported `author` field, so the requesting player is correctly credited.

## Changes made during the audit

- Added authoritative rule/progress validation and bounded resource-intensive rewards before execution.
- Sanitized reward snapshots without imposing source-actor ownership requirements on module-approved inspection or sharing.
- Hardened malformed-request/roll and startup/transport failure handling.
- Corrected normal sheet access for living tokens under defeated-only rules.
- Added explicit GM progress-reset recovery for invalid progress and safe optional nameplate refresh handling.
- Documented the four sounds as CC0 from Freesound based on the project author's confirmation, separately from the code's MIT license.

## Limits of this verification

This is targeted automated and native integration testing, not a guarantee covering every possible third-party module, custom sheet, macro, or operating-system failure. Configured macros intentionally run with their configured permissions; their contents are not sandboxed by this module. If an external inventory hook, macro, or disk write fails, the module reports the failure and preserves recorded progress rather than automatically retrying and risking duplicate rewards. No GitHub publication or upload was performed by this audit.
