import type { CreateLinkInput, Link, LinkStore } from "../domain/link.js";

export class MemoryLinkStore implements LinkStore {
  readonly #links = new Map<string, Link>();

  constructor(private readonly maxLinks: number) {}

  async create(input: CreateLinkInput): Promise<Link | null> {
    if (this.#links.has(input.code)) return null;
    if (this.#links.size >= this.maxLinks) {
      const oldest = this.#links.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#links.delete(oldest);
    }
    const link: Link = { ...input, createdAt: new Date(), clicks: 0 };
    this.#links.set(link.code, link);
    return { ...link };
  }

  async find(code: string): Promise<Link | null> {
    const link = this.#links.get(code);
    if (!link) return null;
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      this.#links.delete(code);
      return null;
    }
    return { ...link };
  }

  async recordClick(code: string): Promise<void> {
    const link = this.#links.get(code);
    if (link) link.clicks += 1;
  }

  async size(): Promise<number> {
    return this.#links.size;
  }
}
