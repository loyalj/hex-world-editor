import { auditRivers, RIVER_ISSUE_LABELS } from '../tools/riverGraph.ts';
import type { RiverIssueKind } from '../tools/riverGraph.ts';
import { initAuditDialog } from './auditDialog.ts';
import type { AuditDialogApi, AuditDialogOptions } from './auditDialog.ts';

export type RiverAuditOptions = Pick<AuditDialogOptions<RiverIssueKind>, 'scene' | 'focusCell'>;
export type RiverAuditApi = AuditDialogApi;

const ISSUE_ORDER: RiverIssueKind[] = ['dangling', 'cycle', 'uphill', 'dead-end', 'low-source'];

/**
 * The river health check: dangling half-edges, loops, uphill runs, land dead
 * ends, and sources below the dialog's elevation threshold.
 */
export function initRiverAudit(opts: RiverAuditOptions): RiverAuditApi {
  const { scene } = opts;
  return initAuditDialog<RiverIssueKind>({
    ...opts,
    prefix:  'river-audit',
    noun:    'river',
    labels:  RIVER_ISSUE_LABELS,
    order:   ISSUE_ORDER,
    hasCell: (col, row) => scene.map.hasRiver(col, row),
    audit:   minSource => auditRivers(scene.map, t => scene.isWater(t), minSource),
  });
}
