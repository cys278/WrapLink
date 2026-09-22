import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

export interface ApiKeyAuthenticator {
  authenticate(candidate: unknown): boolean;
}

function hashApiKey(apiKey: string): Buffer {
  return createHash("sha256")
    .update(apiKey, "utf8")
    .digest();
}

export class HashedApiKeyAuthenticator
  implements ApiKeyAuthenticator
{
  private readonly hashes: readonly Buffer[];

  constructor(apiKeys: readonly string[]) {
    if (apiKeys.length === 0) {
      throw new Error(
        "At least one API key must be configured",
      );
    }

    for (const apiKey of apiKeys) {
      if (apiKey.length < 32) {
        throw new Error(
          "API keys must contain at least 32 characters",
        );
      }
    }

    // Retain only hashes inside the authenticator.
    this.hashes = apiKeys.map(hashApiKey);
  }

  authenticate(candidate: unknown): boolean {
    if (
      typeof candidate !== "string" ||
      candidate.length < 32 ||
      candidate.length > 256
    ) {
      return false;
    }

    const candidateHash = hashApiKey(candidate);
    let authenticated = false;

    // Compare against every configured hash rather than
    // returning early after the first match.
    for (const expectedHash of this.hashes) {
      authenticated =
        timingSafeEqual(
          candidateHash,
          expectedHash,
        ) || authenticated;
    }

    return authenticated;
  }
}