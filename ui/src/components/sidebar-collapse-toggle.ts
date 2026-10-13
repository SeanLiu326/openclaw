import { html } from "lit";
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { icons } from "./icons.ts";

export function renderSidebarCollapseToggle(host: { onToggleSidebar?: () => void }) {
  return html`<openclaw-tooltip
    .content=${`${t("nav.collapse")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`}
  >
    <button
      type="button"
      class="sidebar-session-toolbar__button sidebar-session-toolbar__collapse"
      aria-label=${t("nav.collapse")}
      aria-expanded="true"
      @click=${() => host.onToggleSidebar?.()}
    >
      ${icons.panelLeftClose}
    </button>
  </openclaw-tooltip>`;
}
