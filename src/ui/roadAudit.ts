import { auditRoads, ROAD_ISSUE_LABELS } from '../tools/roadGraph.ts';
import type { RoadIssueKind } from '../tools/roadGraph.ts';
import { initAuditDialog } from './auditDialog.ts';
import type { AuditDialogApi, AuditDialogOptions } from './auditDialog.ts';

export type RoadAuditOptions = Pick<AuditDialogOptions<RoadIssueKind>, 'scene' | 'focusCell'>;
export type RoadAuditApi = AuditDialogApi;

const ISSUE_ORDER: RoadIssueKind[] = ['dangling', 'water', 'cliff', 'fragment', 'spur'];

/**
 * The road health check: dangling half-edges, roads on water, cliff
 * crossings, and the stubs and fragments shorter than the dialog's threshold.
 */
export function initRoadAudit(opts: RoadAuditOptions): RoadAuditApi {
  const { scene } = opts;
  return initAuditDialog<RoadIssueKind>({
    ...opts,
    prefix:  'road-audit',
    noun:    'road',
    labels:  ROAD_ISSUE_LABELS,
    order:   ISSUE_ORDER,
    hasCell: (col, row) => scene.map.hasRoads(col, row),
    audit:   shortLength => auditRoads(scene.map, t => scene.isWater(t), Math.max(1, shortLength)),
  });
}
