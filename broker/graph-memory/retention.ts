export type RetentionTargetKind = "observation" | "assertion" | "statement";

export type RetentionEvidence = {
  id: string;
  observationId: string;
  independenceGroup: string;
  bundleId: string;
  capturedAtUs: number;
  baselineExpiresAtUs: number | null;
  erased: boolean;
};

export type RetentionTarget = {
  kind: RetentionTargetKind;
  id: string;
  lookupId: string;
  scopeId: string;
  status?: string;
  erased: boolean;
  capturedAtUs: number;
  baselineExpiresAtUs: number | null;
  evidence: RetentionEvidence[];
};

export type RetentionHold = {
  id: string;
  reason: string;
  expiresAtUs: number | null;
  evidenceIds: string[];
};

export type RetentionDecision = {
  storageAllowed: boolean;
  recallAllowedByRetention: boolean;
  effectiveExpiresAtUs: number | null;
  nextEvidenceLossAtUs: number | null;
  lastSupportLossAtUs: number | null;
  protectionReasons: string[];
  requiredEvidenceIds: string[];
};

export type RetentionReader = {
  all(sql: string, ...args: unknown[]): Record<string, any>[];
  one(sql: string, ...args: unknown[]): Record<string, any>;
};

const finiteMin = (values: (number | null)[]) => {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length ? Math.min(...finite) : null;
};

const overlayDeadline = (baseline: number | null, protections: (number | null)[]) => {
  if (protections.some((deadline) => deadline === null)) return null;
  const finite = [baseline, ...protections].filter((deadline): deadline is number => deadline !== null);
  return finite.length ? Math.max(...finite) : null;
};

/**
 * How many witnesses a restated record keeps, besides those that must stay. Each restatement attaches
 * one; without a bound a habitually repeated claim would outgrow what a review may read (16 pieces of
 * evidence). Four recent independent sources are enough for review and keep the record's support
 * following its latest mentions.
 */
export const restatementSupportLimit = 4;

/**
 * The support a restated record keeps: every witness in `keep` (the new one, and any a hold protects,
 * so a hold never loses what it was protecting), then the most recently recorded others, at most
 * `limit` in all unless `keep` alone is larger. Order is preserved.
 */
export function restatedSupport<T extends Record<string, any>>(supports: T[], keep: Set<string>, limit = restatementSupportLimit): T[] {
  const kept = new Set<string>(supports.filter((item) => keep.has(item.id)).map((item) => item.id));
  for (const item of supports.filter((item) => !keep.has(item.id)).sort((a, b) => Number(b.revision) - Number(a.revision) || String(b.id).localeCompare(String(a.id))))
    if (kept.size < limit) kept.add(item.id);
  return supports.filter((item) => kept.has(item.id));
}

/** An expiry is inactive at equality everywhere; callers capture nowUs once. */
export const retentionDeadlineActive = (expiresAtUs: number | null, nowUs: number) =>
  expiresAtUs === null || expiresAtUs > nowUs;

export function activeRetentionHolds(
  store: RetentionReader,
  target: Pick<RetentionTarget, "kind" | "lookupId">,
  nowUs: number,
): RetentionHold[] {
  return store.all(
    `SELECT h.id,h.reason,h.expires_at_us,
      COALESCE(json_group_array(he.evidence_id) FILTER (WHERE he.evidence_id IS NOT NULL),'[]') AS evidence_ids
     FROM retention_holds h
     LEFT JOIN retention_hold_evidence he ON he.hold_id=h.id
     WHERE h.target_kind=? AND h.target_id=? AND h.released_revision IS NULL
       AND (h.expires_at_us IS NULL OR h.expires_at_us>?)
     GROUP BY h.id ORDER BY h.created_revision,h.id`,
    target.kind,
    target.lookupId,
    nowUs,
  ).map((row) => ({
    id: row.id,
    reason: row.reason,
    expiresAtUs: row.expires_at_us ?? null,
    evidenceIds: JSON.parse(row.evidence_ids || "[]").filter(Boolean),
  }));
}

/**
 * The sole record-level retention decision: expiry (Canonical.expire, through
 * storageEnded), recall (hydrateArtifact) and forecasts all ask it. Which excerpts
 * outlive their raw turn is decided per piece of evidence (retainedEvidenceIds)
 * from the same holds and accepted status. Scope, valid time, trust and route
 * authorization deliberately remain outside it.
 */
export function planRetention(
  store: RetentionReader,
  target: RetentionTarget,
  options: { nowUs: number; retainEvidence: boolean },
): RetentionDecision {
  const { nowUs, retainEvidence } = options;
  if (target.erased) return {
    storageAllowed: false,
    recallAllowedByRetention: false,
    effectiveExpiresAtUs: target.baselineExpiresAtUs,
    nextEvidenceLossAtUs: null,
    lastSupportLossAtUs: null,
    protectionReasons: [],
    requiredEvidenceIds: [],
  };

  const holds = activeRetentionHolds(store, target, nowUs);
  const heldEvidence = new Set(holds.flatMap((hold) => hold.evidenceIds));
  const acceptedEvidence = (target.kind === "assertion" || target.kind === "statement") && target.status === "accepted" && retainEvidence;
  const protectedTarget = holds.length > 0 || acceptedEvidence;
  const reasons = [...new Set([
    ...holds.map((hold) => hold.reason),
    ...(acceptedEvidence ? ["accepted_evidence"] : []),
  ])];

  const liveEvidence = target.evidence.filter((evidence) => !evidence.erased);
  const bundleLosses = new Map<string, number | null>();
  for (const evidence of liveEvidence) {
    const covering = holds.filter((hold) => hold.evidenceIds.includes(evidence.id)).map((hold) => hold.expiresAtUs);
    const loss = acceptedEvidence ? null : overlayDeadline(evidence.baselineExpiresAtUs, covering);
    const previous = bundleLosses.get(evidence.bundleId);
    // Evidence in one bundle is all-required, so the first member loss breaks it.
    bundleLosses.set(evidence.bundleId, previous === undefined ? loss : finiteMin([previous, loss]));
  }
  const bundleLoss = [...bundleLosses.values()];
  const nextEvidenceLossAtUs = finiteMin(bundleLoss);
  const lastSupportLossAtUs = bundleLoss.length === 0
    ? null
    : bundleLoss.some((loss) => loss === null)
      ? null
      : Math.max(...bundleLoss as number[]);

  const targetExpiresAtUs = overlayDeadline(target.baselineExpiresAtUs, holds.map((hold) => hold.expiresAtUs));
  const baselineActive = retentionDeadlineActive(targetExpiresAtUs, nowUs);
  const supportActive = target.kind === "observation"
    ? baselineActive
    : liveEvidence.length > 0 && (lastSupportLossAtUs === null || lastSupportLossAtUs > nowUs);
  const storageAllowed = baselineActive && supportActive;
  const effectiveExpiresAtUs = finiteMin([targetExpiresAtUs, lastSupportLossAtUs]);

  return {
    storageAllowed,
    recallAllowedByRetention: storageAllowed,
    effectiveExpiresAtUs,
    nextEvidenceLossAtUs,
    lastSupportLossAtUs,
    protectionReasons: reasons,
    requiredEvidenceIds: protectedTarget
      ? [...new Set(acceptedEvidence ? liveEvidence.map((evidence) => evidence.id) : [...heldEvidence])]
      : [],
  };
}
