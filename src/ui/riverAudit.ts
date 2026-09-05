import { auditRivers, RIVER_ISSUE_LABELS } from '../tools/riverGraph.ts';
import type { RiverIssue, RiverIssueKind } from '../tools/riverGraph.ts';
import type { SceneApi } from '../scene.ts';
import type { CellPos } from '../tools/tool.ts';

export interface RiverAuditOptions {
  scene: SceneApi;
  /** Pan the camera to a cell. Wired by main, since it needs the world layout. */
  focusCell(cell: CellPos): void;
}

export interface RiverAuditApi {
  /** Run the audit and show the dialog. */
  open(): void;
}

const ISSUE_ORDER: RiverIssueKind[] = ['dangling', 'cycle', 'uphill', 'dead-end', 'low-source'];

/**
 * The river health check: a dialog listing every way the map's rivers go
 * wrong — dangling half-edges, loops, uphill runs, land dead ends, sources
 * below a chosen elevation — grouped by kind. Clicking a row flies the camera
 * to the cell and outlines it so the problem can be fixed with the river
 * tools; the list re-runs on demand so a fix can be checked off.
 */
export function initRiverAudit(opts: RiverAuditOptions): RiverAuditApi {
  const { scene } = opts;
  const dialog   = document.getElementById('river-audit-dialog')     as HTMLDialogElement;
  const closeBtn = document.getElementById('river-audit-close-btn')  as HTMLButtonElement;
  const rerunBtn = document.getElementById('river-audit-rerun-btn')  as HTMLButtonElement;
  const minInput = document.getElementById('river-audit-min-source') as HTMLInputElement;
  const summary  = document.getElementById('river-audit-summary')    as HTMLElement;
  const list     = document.getElementById('river-audit-list')       as HTMLElement;

  function run(): void {
    const minSource = parseInt(minInput.value, 10) || 0;
    const issues = auditRivers(scene.map, t => scene.isWater(t), minSource);
    render(issues);
  }

  function render(issues: RiverIssue[]): void {
    list.innerHTML = '';
    let riverCells = 0;
    for (let row = 0; row < scene.map.height; row++) {
      for (let col = 0; col < scene.map.width; col++) if (scene.map.hasRiver(col, row)) riverCells++;
    }
    if (riverCells === 0) {
      summary.textContent = 'No rivers on the map.';
      return;
    }
    if (issues.length === 0) {
      summary.textContent = `${riverCells} river cells, no problems found.`;
      return;
    }
    summary.textContent = `${riverCells} river cells · ${issues.length} problem${issues.length === 1 ? '' : 's'}`;
    for (const kind of ISSUE_ORDER) {
      const group = issues.filter(i => i.kind === kind);
      if (group.length === 0) continue;
      const header = document.createElement('div');
      header.className = 'audit-group';
      header.textContent = `${RIVER_ISSUE_LABELS[kind]} · ${group.length}`;
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
  minInput.addEventListener('change', run);

  return {
    open() {
      run();
      if (!dialog.open) dialog.showModal();
    },
  };
}
