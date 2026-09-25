import {
  describe,
  expect,
  it,
} from "vitest";
import {
  SafeUrlPolicy,
  isUnsafeIpAddress,
  type HostnameResolver,
} from "../src/security/url-policy.js";

function resolver(
  ...addresses: string[]
): HostnameResolver {
  return {
    async resolve() {
      return addresses.map((address) => ({
        address,
      }));
    },
  };
}

describe("SafeUrlPolicy", () => {
  it("accepts public HTTP and HTTPS destinations", async () => {
    const policy = new SafeUrlPolicy(
      resolver("93.184.216.34"),
    );

    await expect(
      policy.validate(
        "https://example.com/docs?view=1",
      ),
    ).resolves.toBe(
      "https://example.com/docs?view=1",
    );

    await expect(
      policy.validate("http://example.com"),
    ).resolves.toBe("http://example.com/");
  });

  it("rejects unsupported protocols", async () => {
    const policy = new SafeUrlPolicy(
      resolver("93.184.216.34"),
    );

    await expect(
      policy.validate("javascript:alert(1)"),
    ).resolves.toBeNull();

    await expect(
      policy.validate("file:///etc/passwd"),
    ).resolves.toBeNull();
  });

  it("rejects URLs containing credentials", async () => {
    const policy = new SafeUrlPolicy(
      resolver("93.184.216.34"),
    );

    await expect(
      policy.validate(
        "https://admin:password@example.com",
      ),
    ).resolves.toBeNull();
  });

  it("rejects localhost hostnames", async () => {
    const policy = new SafeUrlPolicy(
      resolver("93.184.216.34"),
    );

    await expect(
      policy.validate("http://localhost:3000"),
    ).resolves.toBeNull();

    await expect(
      policy.validate("http://api.localhost"),
    ).resolves.toBeNull();

    await expect(
      policy.validate("http://service.local"),
    ).resolves.toBeNull();
  });

  it("rejects private and reserved IPv4 addresses", async () => {
    const policy = new SafeUrlPolicy();

    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
    ]) {
      await expect(
        policy.validate(`http://${address}`),
      ).resolves.toBeNull();
    }
  });

  it("rejects unsafe IPv6 addresses", () => {
    expect(isUnsafeIpAddress("::1")).toBe(
      true,
    );

    expect(
      isUnsafeIpAddress("fd00::1"),
    ).toBe(true);

    expect(
      isUnsafeIpAddress("fe80::1"),
    ).toBe(true);

    expect(
      isUnsafeIpAddress(
        "::ffff:192.168.1.1",
      ),
    ).toBe(true);
  });

  it("rejects hostnames resolving to private addresses", async () => {
    const policy = new SafeUrlPolicy(
      resolver("10.0.0.5"),
    );

    await expect(
      policy.validate(
        "https://internal.example.com",
      ),
    ).resolves.toBeNull();
  });

  it("rejects mixed public and private DNS answers", async () => {
    const policy = new SafeUrlPolicy(
      resolver(
        "93.184.216.34",
        "192.168.1.10",
      ),
    );

    await expect(
      policy.validate("https://example.com"),
    ).resolves.toBeNull();
  });

  it("fails closed when DNS resolution fails", async () => {
    const failingResolver: HostnameResolver = {
      async resolve() {
        throw new Error("DNS unavailable");
      },
    };

    const policy = new SafeUrlPolicy(
      failingResolver,
    );

    await expect(
      policy.validate("https://example.com"),
    ).resolves.toBeNull();
  });

  it("rejects malformed and oversized values", async () => {
    const policy = new SafeUrlPolicy(
      resolver("93.184.216.34"),
    );

    await expect(
      policy.validate(undefined),
    ).resolves.toBeNull();

    await expect(
      policy.validate("not a URL"),
    ).resolves.toBeNull();

    await expect(
      policy.validate(
        `https://example.com/${"x".repeat(
          2_048,
        )}`,
      ),
    ).resolves.toBeNull();
  });
});