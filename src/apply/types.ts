import type { Identity, Range, Sha } from "../git/types.js";

export interface PlannedCluster {
  id: string;
  type: string;
  scope?: string;
  subject: string;
  body?: string;
  memberShas: Sha[];
  preserveTrailers?: string[];
}

export interface AppliedPlan {
  range: Range;
  clusters: PlannedCluster[];
  dropped: Sha[];
  targetAuthor: Identity;
}

export interface ApplyOutcome {
  backupRef: string;
  newHead: Sha;
  originalBranch: string;
  clustersApplied: number;
}
