// Pure JOIN of the QIG registries into the integrity-dashboard view.
//
// ZERO classification lives here. Every bucket / gap / dormancy DECISION is
// computed Python-side in qig-verification (tested, CI-guarded) and emitted as
// JSON; this layer only stitches the fetched JSON together for rendering. The
// only derivations it performs are display arithmetic (dormant-day counts) and
// reuse of the sync's own `classifyStatus` to mechanically pick the in-flight
// slice of the verification registry — never a new classification scheme.
//
// Missing sources degrade honestly: before Phase 1 of the rebuild lands on
// qig-verification main, `integrity_registry` and `completeness` are absent, so
// certified / open-questions / completeness render empty and `meta.sources`
// records the gap. The page shows a banner; it never pretends the data is there.
//
// classifyStatus / normalizeDate are imported from doctrine-sync (their single
// definition); doctrine-sync imports THIS module dynamically inside syncDoctrine,
// so the static import here resolves against an already-loaded module — no cycle.

import { classifyStatus, normalizeDate } from './doctrine-sync';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IN_FLIGHT = new Set(['planned', 'in_progress']);

// "20260712-frozen-facts-primary-1.08F.md" -> "1.08F"
function ledgerLabelFromBasename(name) {
  const m = /-(\d+\.\d+[A-Z]?)\.(?:md|json)$/.exec(String(name || ''));
  return m ? m[1] : null;
}

export function buildIntegrityView({
  integrityRegistry = null,
  retiredRegistry = null,
  verificationRegistry = null,
  meshRegistry = null,
  completeness = null,
  ledgerMeta = null,
  syncedAt = null,
} = {}) {
  const ir = integrityRegistry && typeof integrityRegistry === 'object' ? integrityRegistry : null;

  // CERTIFIED + OPEN questions: verbatim from the curated integrity_registry.
  const certified = Array.isArray(ir?.certified) ? ir.certified : [];
  const openQuestions = Array.isArray(ir?.open) ? ir.open : [];

  // In-flight: mechanically derived from the verification registry (planned /
  // in_progress), reusing the SAME classifier the sync uses. No new scheme.
  const inFlight = (Array.isArray(verificationRegistry) ? verificationRegistry : [])
    .map((e) => ({ e, cls: classifyStatus(e?.status).class }))
    .filter((x) => IN_FLIGHT.has(x.cls))
    .map(({ e, cls }) => ({
      id: e.id ?? null,
      status_class: cls,
      status: String(e.status ?? '').slice(0, 180),
      date: normalizeDate(e.date),
      summary: String(e.summary ?? e.hypothesis ?? e.claim ?? '').slice(0, 240),
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // RETIRED: fully mechanical from retired_registry — never reclassed.
  const retired = (Array.isArray(retiredRegistry) ? retiredRegistry : []).map((e) => ({
    id: e.id ?? null,
    claim: String(e.claim ?? e.summary ?? e.hypothesis ?? '').slice(0, 400),
    status: e.status ?? null,
    reason: String(e.reason ?? e.why ?? e.note ?? '').slice(0, 400),
    superseded_by: e.superseded_by ?? e.replaced_by ?? null,
    date: normalizeDate(e.date),
  }));

  // MESH dormancy: DERIVED and display-only — never a mutation of mesh_registry.
  const syncedMs = syncedAt ? Date.parse(syncedAt) : Date.now();
  const mesh = (Array.isArray(meshRegistry) ? meshRegistry : []).map((e) => {
    const d = normalizeDate(e.date);
    const dormantDays = d ? Math.max(0, Math.round((syncedMs - Date.parse(d)) / DAY_MS)) : null;
    return {
      id: e.id ?? null,
      status_class: classifyStatus(e?.status).class,
      status: String(e.status ?? '').slice(0, 180),
      date: d,
      dormant_days: dormantDays,
      // The filesystem "results dir present?" check is not available in JS; the
      // presence of a result_file pointer is the honest proxy the entry carries.
      dir_present: Boolean(e.result_file),
    };
  });

  // Staleness (the ledger-mismatch half — knowable at sync time). The curation
  // was built against a specific ledger; if the LIVE ledger has moved past it,
  // the curated CERTIFIED/OPEN sets may be behind. The sync-AGE half is computed
  // at render time from synced_at (the banner), since it is always fresh here.
  const curationLedgerLabel = ledgerLabelFromBasename(ir?.source_ledger);
  const liveLedgerLabel = ledgerMeta?.version_label ?? null;
  const ledgerMismatch = Boolean(
    curationLedgerLabel && liveLedgerLabel && curationLedgerLabel !== liveLedgerLabel,
  );

  return {
    certified,
    open: { questions: openQuestions, in_flight: inFlight },
    retired,
    completeness: completeness && typeof completeness === 'object' ? completeness : null,
    mesh,
    meta: {
      ledger_version: liveLedgerLabel,
      ledger_date: ledgerMeta?.date ?? null,
      curation_ledger: curationLedgerLabel,
      curation_version: ir?.version ?? null,
      curation_date: ir?.date ?? null,
      ledger_mismatch: ledgerMismatch,
      // `stale` here reflects only the ledger-mismatch; the page ORs in sync-age.
      stale: ledgerMismatch,
      synced_at: syncedAt ?? null,
      sources: {
        integrity_registry: Boolean(ir),
        completeness: Boolean(completeness && typeof completeness === 'object'),
      },
    },
  };
}
