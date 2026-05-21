/**
 * Keyboard-shortcut reference modal. A read-only "cheat sheet" view
 * of the ribbon's bound F-keys / Mod-keys, grouped conceptually.
 *
 * The command source-of-truth is `RIBBON_COMMAND_IDS` in
 * `ribbon-commands.ts`. Every command in that registry MUST appear
 * in exactly one group below — a module-init assertion enforces
 * this so the cheat sheet can't silently drift out of sync when a
 * new bindable action is added to the registry.
 */

import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  formatKeyForDisplay,
  type RibbonCommandId,
} from './ribbon-commands.js';
import { settings } from './settings.js';

interface ShortcutGroup {
  title: string;
  commands: RibbonCommandId[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'File',
    commands: ['newDocument', 'openFile', 'save', 'saveAs', 'toggleAutosave'],
  },
  {
    title: 'Speech',
    commands: [
      'newSpeechDocument',
      'markActiveAsSpeech',
      'sendToSpeechAtCursor',
      'sendToSpeechAtEnd',
    ],
  },
  {
    title: 'Structural styles',
    commands: ['setPocket', 'setHat', 'setBlock', 'setTag', 'setAnalytic', 'setUndertag'],
  },
  {
    title: 'Character styles',
    commands: [
      'applyCite',
      'applyUnderline',
      'applyEmphasis',
      'applyHighlight',
      'applyShading',
      'applyFontColor',
    ],
  },
  {
    title: 'Inline formatting',
    commands: [
      'toggleBold',
      'toggleItalic',
      'toggleStrikethrough',
      'toggleSuperscript',
      'toggleSubscript',
      'adjustFontSizeUp',
      'adjustFontSizeDown',
    ],
  },
  {
    title: 'Condense',
    commands: [
      'condenseDefault',
      'condenseNoIntegrity',
      'condenseNoIntegrityWithPilcrows',
      'condenseWithWarning',
      'uncondense',
      'toggleCase',
      'toggleParagraphIntegrity',
    ],
  },
  {
    title: 'Editing utilities',
    commands: [
      'pasteAsText',
      'clearToNormal',
      'shrink',
      'copyPreviousCite',
      'createReference',
      'insertImage',
    ],
  },
  {
    title: 'Highlight tools',
    commands: [
      'standardizeHighlight',
      'standardizeShading',
      'highlightToShading',
      'shadingToHighlight',
      'togglePaintbrushHighlight',
      'togglePaintbrushShading',
    ],
  },
  {
    title: 'Color pickers & menus',
    commands: [
      'openHighlightPicker',
      'openShadingPicker',
      'openFontColorPicker',
      'openFontSizePicker',
      'openDocToolsMenu',
      'openCardToolsMenu',
      'openTableMenu',
    ],
  },
  {
    title: 'Find',
    commands: ['openFind', 'openFindReplace', 'openFindByProximity'],
  },
  {
    title: 'View',
    commands: [
      'toggleReadMode',
      'toggleNavPane',
      'wordCountSelection',
      'openSettings',
      'openShortcutsReference',
    ],
  },
  {
    title: 'Zoom & scale',
    commands: [
      'zoomIn',
      'zoomOut',
      'zoomReset',
      'chromeScaleUp',
      'chromeScaleDown',
      'chromeScaleReset',
    ],
  },
  {
    title: 'Comments',
    commands: ['toggleCommentsVisible', 'addCommentToSelection'],
  },
  {
    title: 'AI',
    commands: ['aiAskAboutSelection', 'aiCreateCite'],
  },
  {
    title: 'Select',
    commands: ['selectSimilar'],
  },
  {
    title: 'Cleanup',
    commands: [
      'convertAnalyticsToTags',
      'fixFormattingGaps',
      'removeHyperlinks',
    ],
  },
  {
    title: 'Table',
    commands: [
      'insertTable',
      'addRowBefore',
      'addRowAfter',
      'addColumnBefore',
      'addColumnAfter',
      'deleteTableRow',
      'deleteTableColumn',
      'mergeTableCells',
      'splitTableCell',
      'deleteTable',
    ],
  },
];

// Drift guard: every `RibbonCommandId` must appear in exactly one
// group above. If a new command is added to the registry and someone
// forgets to update GROUPS, this throws at module load time — fail
// loud instead of silently dropping rows from the cheat sheet.
(function assertGroupsCoverRegistry(): void {
  const placed = new Set<string>();
  const duplicates: string[] = [];
  for (const group of GROUPS) {
    for (const id of group.commands) {
      if (placed.has(id)) duplicates.push(id);
      placed.add(id);
    }
  }
  const missing = RIBBON_COMMAND_IDS.filter((id) => !placed.has(id));
  const extra = [...placed].filter(
    (id) => !(RIBBON_COMMAND_IDS as readonly string[]).includes(id),
  );
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`missing from GROUPS: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`in GROUPS but not in RIBBON_COMMAND_IDS: ${extra.join(', ')}`);
  }
  if (duplicates.length > 0) {
    problems.push(`appear in multiple groups: ${duplicates.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `reference-ui GROUPS / RIBBON_COMMAND_IDS mismatch:\n  - ${problems.join('\n  - ')}`,
    );
  }
})();

class ReferenceModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-reference-overlay';
    this.overlay.style.display = 'none';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-reference-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (this.overlay.style.display !== 'none' && e.key === 'Escape') {
        this.close();
      }
    });

    document.body.appendChild(this.overlay);
  }

  open(): void {
    this.render();
    this.overlay.style.display = '';
  }

  close(): void {
    this.overlay.style.display = 'none';
  }

  private render(): void {
    this.dialog.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'pmd-reference-header';
    const title = document.createElement('h2');
    title.textContent = 'Keyboard shortcuts';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-reference-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-reference-body';

    for (const group of GROUPS) {
      const section = document.createElement('section');
      section.className = 'pmd-reference-group';

      const heading = document.createElement('h3');
      heading.className = 'pmd-reference-group-title';
      heading.textContent = group.title;
      section.appendChild(heading);

      const rows = document.createElement('div');
      rows.className = 'pmd-reference-group-rows';

      for (const id of group.commands) {
        const row = document.createElement('div');
        row.className = 'pmd-reference-row';

        // Live overrides from settings take precedence over defaults
        // so the cheat sheet always reflects the user's current
        // bindings (including unbound / freshly-customized commands).
        const overrides = settings.get('ribbonKeyOverrides');
        const keySpec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
        const keys = Array.isArray(keySpec) ? keySpec : [keySpec];
        const keyText = keys
          .map((k) => formatKeyForDisplay(k))
          .filter((s) => s.length > 0)
          .join(' / ');

        const keyEl = document.createElement('span');
        keyEl.className = 'pmd-reference-key';
        keyEl.textContent = keyText || '—';
        row.appendChild(keyEl);

        const labelEl = document.createElement('span');
        labelEl.className = 'pmd-reference-label';
        labelEl.textContent = RIBBON_COMMAND_LABELS[id];
        row.appendChild(labelEl);

        rows.appendChild(row);
      }

      section.appendChild(rows);
      body.appendChild(section);
    }

    this.dialog.appendChild(body);
  }
}

let modal: ReferenceModal | null = null;

export function openReference(): void {
  if (!modal) modal = new ReferenceModal();
  modal.open();
}
