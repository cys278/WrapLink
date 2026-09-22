import {
  describe,
  expect,
  it,
} from "vitest";
import { HashedApiKeyAuthenticator } from "../src/security/api-key-authenticator.js";

const firstKey =
  "wraplink-test-key-0000000000000001";
const secondKey =
  "wraplink-test-key-0000000000000002";

describe("HashedApiKeyAuthenticator", () => {
  it("accepts every configured API key", () => {
    const authenticator =
      new HashedApiKeyAuthenticator([
        firstKey,
        secondKey,
      ]);

    expect(
      authenticator.authenticate(firstKey),
    ).toBe(true);

    expect(
      authenticator.authenticate(secondKey),
    ).toBe(true);
  });

  it("rejects invalid credentials", () => {
    const authenticator =
      new HashedApiKeyAuthenticator([
        firstKey,
      ]);

    expect(
      authenticator.authenticate(
        "wraplink-test-key-0000000000000099",
      ),
    ).toBe(false);

    expect(
      authenticator.authenticate(undefined),
    ).toBe(false);

    expect(
      authenticator.authenticate([
        firstKey,
        secondKey,
      ]),
    ).toBe(false);
  });

  it("requires at least one API key", () => {
    expect(
      () =>
        new HashedApiKeyAuthenticator([]),
    ).toThrow(
      "At least one API key must be configured",
    );
  });

  it("rejects short API keys", () => {
    expect(
      () =>
        new HashedApiKeyAuthenticator([
          "too-short",
        ]),
    ).toThrow(
      "API keys must contain at least 32 characters",
    );
  });
});