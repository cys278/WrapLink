export interface Link {
  code: string;
  targetUrl: string;
  createdAt: Date;
  expiresAt: Date | null;
  clicks: number;
}

export interface CreateLinkInput {
  code: string;
  targetUrl: string;
  expiresAt: Date | null;
  /**
   * "custom" codes are chosen by people and frequently collide, so they
   * always take the synchronous, PostgreSQL-checked path. "generated"
   * codes are unique by construction and may be written behind.
   * Defaults to "generated".
   */
  codeSource?: "custom" | "generated";
}

/** A link accepted by Redis that is waiting to be written to PostgreSQL. */
export interface PendingLink {
  code: string;
  targetUrl: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface LinkStore {
  create(input: CreateLinkInput): Promise<Link | null>;
  find(code: string): Promise<Link | null>;
  recordClick(code: string): Promise<void>;
  size(): Promise<number>;
  isHealthy(): Promise<boolean>;
}