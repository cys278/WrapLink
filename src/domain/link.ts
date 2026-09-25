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
}

export interface LinkStore {
  create(input: CreateLinkInput): Promise<Link | null>;
  find(code: string): Promise<Link | null>;
  recordClick(code: string): Promise<void>;
  size(): Promise<number>;
  isHealthy(): Promise<boolean>;
}