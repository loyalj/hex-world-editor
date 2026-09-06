import type { SceneApi } from '../scene.ts';
import type { CellPos } from '../tools/tool.ts';

export interface AuditIssue<K extends string> extends CellPos {
  kind: K;
  /** One line for the audit list. */
  detail: string;
}

export interface AuditDialogOptions<K extends string> {
  scene: SceneApi;
  /** Pan the camera to a cell. Wired by main, since it needs the world layout. */
  focusCell(cell: CellPos): void;
  /**
   * Element id prefix: the dialog is `${prefix}-dialog`, with `-close-btn`,
   * `-rerun-btn`, `-threshold`, `-summary`, and `-list` alongside.
   */
  prefix: string;
  /** What the summary counts, e.g. "river" → "5 river cells". */
  noun: string;
  labels: Record<K, string>;
  /** Group order in the list — worst first. */
  order: K[];
  /** Whether a cell counts toward the summary's total. */
  hasCell(col: number, row: number): boolean;
  /** Run the check with the dialog's numeric threshold. */
  audit(threshold: number): Array<AuditIssue<K>>;
}

export interface AuditDialogApi {
  /** Run the audit and show the dialog. */
  open(): void;
}

/**
 * A health-check dialog: a summary line, a numeric threshold the check reads,
 * and every problem grouped by kind. Clicking a row flies the camera to the
 * cell and outlines it so the problem can be fixed with the tools; the list
 * re-runs on demand so a fix can be checked off. The river and road checks
 * are both instances of this.
 */
export function initAuditDialog<K extends string>(opts: AuditDialogOptions<K>): AuditDialogApi {
  const { scene, prefix } = opts;
  const dialog    = document.getElementById(`${prefix}-dialog`)    as HTMLDialogElement;
  const closeBtn  = document.getElementById(`${prefix}-close-btn`) as HTMLButtonElement;
  const rerunBtn  = document.getElementById(`${prefix}-rerun-btn`) as HTMLButtonElement;
  const threshold = document.getElementById(`${prefix}-threshold`) as HTMLInputElement;
  const summary   = document.getElementById(`${prefix}-summary`)   as HTMLElement;
  const list      = document.getElementById(`${prefix}-list`)      as HTMLElement;

  function run(): void {
    render(opts.audit(parseInt(threshold.value, 10) || 0));
  }

  function render(issues: Array<AuditIssue<K>>): void {
    list.innerHTML = '';
    let cells = 0;
    for (let row = 0; row < scene.map.height; row++) {
      for (let col = 0; col < scene.map.width; col++) if (opts.hasCell(col, row)) cells++;
    }
    if (cells === 0) {
      summary.textContent = `No ${opts.noun}s on the map.`;
      return;
    }
    if (issues.length === 0) {
      summary.textContent = `${cells} ${opts.noun} cells, no problems found.`;
      return;
    }
    summary.textContent = `${cells} ${opts.noun} cells · ${issues.length} problem${issues.length === 1 ? '' : 's'}`;
    for (const kind of opts.order) {
      const group = issues.filter(i => i.kind === kind);
      if (group.length === 0) continue;
      const header = document.createElement('div');
      header.className = 'audit-group';
      header.textContent = `${opts.labels[kind]} · ${group.length}`;
      list.appendChild(header);
      for (const issue of group) {
        const row = document.createElement('button');
        row.className = 'audit-row';
        row.dataset['kind'] = issue.kind;
        row.dataset['cell'] = `${issue.col},${issue.row}`;
        const where = document.createElement('span');
        where.className = 'audit-cell';
        where.textContent = `${issue.col}, ${issue.row}`;
        const detail = document.createElement('span');
        detail.className = 'audit-detail';
        detail.textContent = issue.detail;
        row.append(where, detail);
        row.addEventListener('click', () => {
          opts.focusCell({ col: issue.col, row: issue.row });
          scene.setSelectionPreview([{ col: issue.col, row: issue.row }]);
        });
        list.appendChild(row);
      }
    }
  }

  closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => scene.setSelectionPreview(null));
  rerunBtn.addEventListener('click', run);
  threshold.addEventListener('change', run);

  return {
    open() {
      run();
      if (!dialog.open) dialog.showModal();
    },
  };
}
