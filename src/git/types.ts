export type Sha = string & { readonly __sha: unique symbol };

export function asSha(s: string): Sha {
  return s as Sha;
}

export interface Identity {
  name: string;
  email: string;
}

export interface Trailer {
  key: string;
  value: string;
  raw: string;
}

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface FileChange {
  path: string;
  oldPath?: string;
  added: number;
  deleted: number;
  status: FileStatus;
}

export interface Commit {
  sha: Sha;
  parents: Sha[];
  author: Identity;
  committer: Identity;
  authoredAt: string;
  committedAt: string;
  subject: string;
  body: string;
  trailers: Trailer[];
  files: FileChange[];
}

export interface Range {
  base: Sha;
  head: Sha;
  baseRef: string;
  headRef: string;
}

export function formatIdentity(id: Identity): string {
  return `${id.name} <${id.email}>`;
}
