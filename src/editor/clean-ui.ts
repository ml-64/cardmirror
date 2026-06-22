/**
 * Clean — a home-screen utility that cleans a `.docx`'s styles to the
 * Verbatim-standard scheme (convert direct formatting to semantic styles,
 * rename/remove stray styles, strip hyperlinks). It can clean a single file or
 * a whole folder (recursed), writing cleaned copies into a chosen destination.
 *
 * The cleaning runs entirely client-side over the style cleaner in
 * `ooxml/style-clean`. Electron-only: needs recursive directory listing +
 * write-to-path, so the home screen only surfaces it on the desktop edition.
 */

import { cleanDocumentBytes } from '../ooxml/style-clean/style-cleaner.js';
import { Docx } from '../ooxml/docx.js';
import { getHost, getElectronHost } from './host/index.js';
import { settings } from './settings.js';
import { setIcon } from './icons';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Read distinct style names (with a paragraph/character/… label) from a
 *  .docx's styles.xml, for the "add from template" picker. */
async function readTemplateStyleNames(bytes: Uint8Array): Promise<{ name: string; type: string }[]> {
  const docx = await Docx.load(bytes);
  const xml = await docx.readText('word/styles.xml');
  if (xml === null) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const seen = new Map<string, string>();
  for (const style of Array.from(doc.getElementsByTagNameNS(W_NS, 'style'))) {
    const nameEl = style.getElementsByTagNameNS(W_NS, 'name')[0];
    const name = nameEl ? (nameEl.getAttributeNS(W_NS, 'val') ?? nameEl.getAttribute('w:val')) : null;
    if (!name || seen.has(name)) continue;
    seen.set(name, style.getAttributeNS(W_NS, 'type') ?? style.getAttribute('w:type') ?? '');
  }
  return [...seen.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface InputSel {
  kind: 'file' | 'folder';
  path: string;
  name: string;
  /** Bytes (file input only). */
  bytes?: Uint8Array;
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

/** Join a destination dir + relative path with a forward slash
 *  (Node's fs accepts it on every platform). */
function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`;
}

/** Prefix the basename of a relative path with `cleaned_` (so output never
 *  overwrites a source file even if the destination is the source folder). */
function cleanedRel(rel: string): string {
  const norm = rel.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dir = slash >= 0 ? norm.slice(0, slash + 1) : '';
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  return `${dir}cleaned_${base}`;
}

/** The directory part of a file path (its containing folder). */
function dirName(p: string): string {
  const m = p.replace(/[\\/]+$/, '').match(/^(.*)[\\/][^\\/]*$/);
  return m ? m[1]! : '';
}

class CleanModal {
  private readonly overlay: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private inputPathEl!: HTMLDivElement;
  private outputPathEl!: HTMLDivElement;
  private cleanBtn!: HTMLButtonElement;
  private barFillEl!: HTMLDivElement;
  private mainBody!: HTMLDivElement;
  private protectedBody!: HTMLDivElement;
  private protectedListEl!: HTMLDivElement;
  private protectedCountEl!: HTMLSpanElement;
  private busy = false;
  private settled = false;

  private inputSel: InputSel | null = null;
  private outputDir: string | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-bulk-overlay';
    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-bulk-dialog';
    this.overlay.appendChild(this.dialog);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', this.onKey, true);
    this.render();
    document.body.appendChild(this.overlay);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.busy) {
      e.preventDefault();
      // Capture-phase: stop Escape from also reaching the home screen's
      // keydown handler (which would dismiss home under the closing modal).
      e.stopPropagation();
      // From the protected-styles panel, Escape backs out to the main view.
      if (this.protectedBody && !this.protectedBody.hidden) this.showProtected(false);
      else this.close();
    }
  };

  private close(): void {
    if (this.settled || this.busy) return;
    this.settled = true;
    document.removeEventListener('keydown', this.onKey, true);
    this.overlay.remove();
  }

  private render(): void {
    const header = document.createElement('header');
    header.className = 'pmd-bulk-header';
    const h = document.createElement('h2');
    h.textContent = 'Clean';
    header.appendChild(h);
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'pmd-bulk-close';
    setIcon(gear, 'settings');
    gear.title = 'Protected styles';
    gear.addEventListener('click', () => this.showProtected(true));
    header.appendChild(gear);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pmd-bulk-close';
    setIcon(close, 'close');
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    header.appendChild(close);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-bulk-body';
    this.mainBody = body;

    const blurb = document.createElement('p');
    blurb.className = 'pmd-bulk-blurb';
    blurb.textContent =
      'Cleans a .docx’s styles to the Verbatim standard — converting stray ' +
      'formatting to the right styles, removing junk styles, and stripping ' +
      'hyperlinks. Cleaned copies are written to the destination.';
    body.appendChild(blurb);

    // Options.
    const optField = document.createElement('div');
    optField.className = 'pmd-bulk-field';
    const optLabel = document.createElement('div');
    optLabel.className = 'pmd-bulk-field-label';
    optLabel.textContent = 'Options';
    optField.appendChild(optLabel);
    // Protected styles — summary + manage link (full editor behind the gear).
    const protRow = document.createElement('div');
    protRow.className = 'pmd-clean-prot-summary';
    this.protectedCountEl = document.createElement('span');
    const manageBtn = button('Manage…', () => this.showProtected(true));
    manageBtn.classList.add('pmd-clean-prot-manage');
    protRow.append(this.protectedCountEl, manageBtn);
    optField.appendChild(protRow);
    body.appendChild(optField);

    // Input.
    const inField = document.createElement('div');
    inField.className = 'pmd-bulk-field';
    const inLabel = document.createElement('div');
    inLabel.className = 'pmd-bulk-field-label';
    inLabel.textContent = 'Input';
    inField.appendChild(inLabel);
    const inBtns = document.createElement('div');
    inBtns.className = 'pmd-bulk-pickrow';
    inBtns.append(
      button('Choose file…', () => void this.pickFile()),
      button('Choose folder…', () => void this.pickFolder()),
    );
    inField.appendChild(inBtns);
    this.inputPathEl = document.createElement('div');
    this.inputPathEl.className = 'pmd-bulk-path';
    inField.appendChild(this.inputPathEl);
    body.appendChild(inField);

    // Destination.
    const outField = document.createElement('div');
    outField.className = 'pmd-bulk-field';
    const outLabel = document.createElement('div');
    outLabel.className = 'pmd-bulk-field-label';
    outLabel.textContent = 'Destination';
    outField.appendChild(outLabel);
    const outBtns = document.createElement('div');
    outBtns.className = 'pmd-bulk-pickrow';
    outBtns.append(button('Choose destination…', () => void this.pickDestination()));
    outField.appendChild(outBtns);
    this.outputPathEl = document.createElement('div');
    this.outputPathEl.className = 'pmd-bulk-path';
    outField.appendChild(this.outputPathEl);
    body.appendChild(outField);

    // Clean.
    const actions = document.createElement('div');
    actions.className = 'pmd-bulk-actions';
    this.cleanBtn = button('Clean', () => void this.run());
    this.cleanBtn.classList.add('pmd-bulk-btn-primary');
    actions.appendChild(this.cleanBtn);
    body.appendChild(actions);

    // Progress bar — runs processed within the current file.
    const bar = document.createElement('div');
    bar.className = 'pmd-bulk-progress';
    this.barFillEl = document.createElement('div');
    this.barFillEl.className = 'pmd-bulk-progress-fill';
    bar.appendChild(this.barFillEl);
    body.appendChild(bar);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'pmd-bulk-status';
    body.appendChild(this.statusEl);

    this.dialog.appendChild(body);
    this.buildProtectedPanel();
    this.updateProtectedCount();
    this.refresh();
  }

  // ── Protected styles panel ─────────────────────────────────────────

  private buildProtectedPanel(): void {
    const panel = document.createElement('div');
    panel.className = 'pmd-bulk-body';
    panel.hidden = true;

    const backRow = document.createElement('div');
    backRow.className = 'pmd-clean-prot-back';
    const back = button('Back', () => this.showProtected(false));
    setIcon(back, 'chevron-left', { label: 'Back' });
    backRow.appendChild(back);
    panel.appendChild(backRow);

    const heading = document.createElement('h3');
    heading.className = 'pmd-bulk-field-label';
    heading.textContent = 'Protected styles';
    panel.appendChild(heading);

    const blurb = document.createElement('p');
    blurb.className = 'pmd-bulk-blurb';
    blurb.textContent =
      'Styles listed here are never pruned, removed, or reassigned by Clean ' +
      '(their dependencies are kept too). Match is by name, case-insensitive.';
    panel.appendChild(blurb);

    this.protectedListEl = document.createElement('div');
    this.protectedListEl.className = 'pmd-clean-prot-list';
    panel.appendChild(this.protectedListEl);

    // Add manually.
    const addField = document.createElement('div');
    addField.className = 'pmd-bulk-field';
    const addLabel = document.createElement('div');
    addLabel.className = 'pmd-bulk-field-label';
    addLabel.textContent = 'Add a style';
    addField.appendChild(addLabel);
    const addRow = document.createElement('div');
    addRow.className = 'pmd-clean-prot-addrow';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Style name';
    input.className = 'pmd-clean-prot-input';
    const submit = (): void => {
      const v = input.value.trim();
      if (v) {
        this.addNames([v]);
        input.value = '';
      }
      input.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    addRow.append(input, button('Add', submit), button('Add from template…', () => void this.addFromTemplate()));
    addField.appendChild(addRow);
    panel.appendChild(addField);

    this.dialog.appendChild(panel);
    this.protectedBody = panel;
    this.refreshProtectedList();
  }

  private showProtected(show: boolean): void {
    this.mainBody.hidden = show;
    this.protectedBody.hidden = !show;
    if (!show) this.updateProtectedCount();
  }

  private getProtectedNames(): string[] {
    return settings.get('cleanProtectedStyles');
  }

  private saveNames(names: string[]): void {
    const cleaned = Array.from(
      new Set(names.map((n) => n.trim()).filter((n) => n.length > 0)),
    );
    settings.set('cleanProtectedStyles', cleaned);
    this.refreshProtectedList();
    this.updateProtectedCount();
  }

  private addNames(names: string[]): void {
    this.saveNames([...this.getProtectedNames(), ...names]);
  }

  private updateProtectedCount(): void {
    const n = this.getProtectedNames().length;
    this.protectedCountEl.textContent =
      n === 0 ? 'No protected styles' : `${n} protected style${n === 1 ? '' : 's'}`;
  }

  private refreshProtectedList(): void {
    const names = this.getProtectedNames();
    this.protectedListEl.innerHTML = '';
    if (names.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-clean-prot-empty';
      empty.textContent = 'None yet.';
      this.protectedListEl.appendChild(empty);
      return;
    }
    names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'pmd-clean-prot-row';
      const field = document.createElement('input');
      field.type = 'text';
      field.value = name;
      field.className = 'pmd-clean-prot-input';
      field.addEventListener('change', () => {
        const next = [...this.getProtectedNames()];
        next[i] = field.value;
        this.saveNames(next);
      });
      const remove = button('Remove', () => {
        const next = this.getProtectedNames().filter((_, j) => j !== i);
        this.saveNames(next);
      });
      remove.classList.add('pmd-clean-prot-remove');
      row.append(field, remove);
      this.protectedListEl.appendChild(row);
    });
  }

  private async addFromTemplate(): Promise<void> {
    const opened = await getHost().openFile({
      filters: [{ name: '.docx', extensions: ['docx'] }],
    });
    if (!opened || !opened.bytes) return;
    let styles: { name: string; type: string }[];
    try {
      styles = await readTemplateStyleNames(opened.bytes);
    } catch {
      styles = [];
    }
    if (styles.length === 0) return;
    this.showTemplatePicker(styles);
  }

  private showTemplatePicker(styles: { name: string; type: string }[]): void {
    const existing = new Set(this.getProtectedNames().map((n) => n.toLowerCase()));
    const overlay = document.createElement('div');
    overlay.className = 'pmd-bulk-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-bulk-dialog';
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const header = document.createElement('header');
    header.className = 'pmd-bulk-header';
    const h = document.createElement('h2');
    h.textContent = 'Add from template';
    header.appendChild(h);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-bulk-body';
    const hint = document.createElement('p');
    hint.className = 'pmd-bulk-blurb';
    hint.textContent = 'Select styles to protect.';
    body.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'pmd-clean-prot-picklist';
    const checks: { name: string; input: HTMLInputElement }[] = [];
    for (const s of styles) {
      const row = document.createElement('label');
      row.className = 'pmd-bulk-radio';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      if (existing.has(s.name.toLowerCase())) {
        cb.checked = true;
        cb.disabled = true;
      }
      const text = document.createElement('span');
      text.textContent = s.type && s.type !== 'paragraph' ? `${s.name}  ·  ${s.type}` : s.name;
      row.append(cb, text);
      list.appendChild(row);
      checks.push({ name: s.name, input: cb });
    }
    body.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'pmd-bulk-actions';
    const add = button('Add selected', () => {
      const picked = checks.filter((c) => c.input.checked && !c.input.disabled).map((c) => c.name);
      if (picked.length) this.addNames(picked);
      overlay.remove();
    });
    add.classList.add('pmd-bulk-btn-primary');
    actions.append(add, button('Cancel', () => overlay.remove()));
    body.appendChild(actions);

    dialog.appendChild(body);
    document.body.appendChild(overlay);
  }

  private setProgress(done: number, total: number): void {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    this.barFillEl.style.width = `${pct}%`;
  }

  /** Update path displays + the Clean button's enabled state. */
  private refresh(): void {
    this.inputPathEl.textContent = this.inputSel
      ? `${this.inputSel.kind === 'folder' ? 'Folder' : 'File'}: ${this.inputSel.path}`
      : 'None selected';
    this.inputPathEl.classList.toggle('pmd-bulk-path-set', !!this.inputSel);
    this.outputPathEl.textContent = this.outputDir
      ? this.outputDir
      : 'Same location as the original (default)';
    this.outputPathEl.classList.toggle('pmd-bulk-path-set', !!this.outputDir);
    this.cleanBtn.disabled = this.busy || !this.inputSel;
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.dialog.classList.toggle('pmd-bulk-busy', on);
    this.refresh();
  }

  private setStatus(msg: string): void {
    this.statusEl.textContent = msg;
  }

  // ── Pickers ───────────────────────────────────────────────────────

  private async pickFile(): Promise<void> {
    const opened = await getHost().openFile({
      filters: [{ name: '.docx', extensions: ['docx'] }],
    });
    if (!opened || typeof opened.handle !== 'string') return;
    this.inputSel = { kind: 'file', path: opened.handle, name: opened.name, bytes: opened.bytes };
    this.refresh();
  }

  private async pickFolder(): Promise<void> {
    const electron = getElectronHost();
    if (!electron) return;
    const folder = await electron.pickDirectory({ title: 'Choose a folder to clean' });
    if (!folder) return;
    this.inputSel = { kind: 'folder', path: folder, name: baseName(folder) };
    this.refresh();
  }

  private async pickDestination(): Promise<void> {
    const electron = getElectronHost();
    if (!electron) return;
    const dest = await electron.pickDirectory({ title: 'Choose a destination folder' });
    if (!dest) return;
    this.outputDir = dest;
    this.refresh();
  }

  // ── Clean ─────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    if (this.busy || !this.inputSel) return;
    const electron = getElectronHost();
    if (!electron) {
      this.setStatus('Clean requires the desktop edition.');
      return;
    }
    const protectedStyleNames = this.getProtectedNames();
    // No destination chosen → write next to the originals (same location).
    const dest = this.outputDir;
    const input = this.inputSel;
    const runs = (cur: number, tot: number, prefix: string): void => {
      this.setProgress(cur, tot);
      this.setStatus(`${prefix} (${cur.toLocaleString()} / ${tot.toLocaleString()} runs)`);
    };
    this.setBusy(true);
    try {
      if (input.kind === 'file') {
        const destDir = dest ?? dirName(input.path);
        this.setProgress(0, 1);
        const cleaned = await cleanDocumentBytes(input.bytes!, {
          protectedStyleNames,
          progressCallback: (cur, tot) => runs(cur, tot, `Cleaning ${input.name}…`),
        });
        await electron.writeFileAtPath(joinPath(destDir, `cleaned_${input.name}`), cleaned);
        this.setProgress(1, 1);
        this.setStatus(`Cleaned “${input.name}”.`);
      } else {
        const destRoot = dest ?? input.path;
        this.setStatus('Scanning…');
        const files = await electron.listFilesRecursive(input.path, 'docx');
        if (files.length === 0) {
          this.setStatus('No .docx files found in that folder.');
          return;
        }
        let ok = 0;
        let failed = 0;
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          this.setProgress(0, 1);
          try {
            const read = await electron.readFileAtPath(f.path);
            if (!read) throw new Error('unreadable');
            const cleaned = await cleanDocumentBytes(read.bytes, {
              protectedStyleNames,
              progressCallback: (cur, tot) =>
                runs(cur, tot, `Cleaning ${i + 1} / ${files.length}: ${baseName(f.relPath)}…`),
            });
            await electron.writeFileAtPath(joinPath(destRoot, cleanedRel(f.relPath)), cleaned);
            ok++;
          } catch (err) {
            failed++;
            console.error('Clean failed for', f.path, err);
          }
        }
        this.setProgress(1, 1);
        this.setStatus(`Done — ${ok} cleaned${failed ? `, ${failed} failed (see console)` : ''}.`);
      }
    } catch (err) {
      this.setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.setBusy(false);
    }
  }
}

// ── Small DOM helper ──────────────────────────────────────────────────

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pmd-bulk-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function openClean(): void {
  new CleanModal();
}
