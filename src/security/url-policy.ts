import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
}

export interface HostnameResolver {
  resolve(
    hostname: string,
  ): Promise<readonly ResolvedAddress[]>;
}

export interface UrlPolicy {
  validate(value: unknown): Promise<string | null>;
}

class DnsHostnameResolver
  implements HostnameResolver
{
  async resolve(
    hostname: string,
  ): Promise<readonly ResolvedAddress[]> {
    return lookup(hostname, {
      all: true,
      verbatim: true,
    });
  }
}

function parseIpv4(
  address: string,
): readonly number[] | null {
  const parts = address.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return Number.NaN;
    }

    return Number(part);
  });

  if (
    octets.some(
      (octet) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255,
    )
  ) {
    return null;
  }

  return octets;
}

function isUnsafeIpv4(address: string): boolean {
  const octets = parseIpv4(address);

  if (!octets) {
    return true;
  }

  const [first, second] = octets;

  if (
    first === undefined ||
    second === undefined
  ) {
    return true;
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 &&
      second >= 64 &&
      second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 &&
      second >= 16 &&
      second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 &&
      (second === 18 || second === 19)) ||
    first >= 224
  );
}

function normalizeIpv6(address: string): string {
  return address
    .toLowerCase()
    .split("%", 1)[0]!
    .replace(/^\[|\]$/g, "");
}

function isUnsafeIpv6(address: string): boolean {
  const normalized = normalizeIpv6(address);

  if (
    normalized === "::" ||
    normalized === "::1"
  ) {
    return true;
  }

  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }

  const firstGroup = normalized.split(":")[0];

  if (firstGroup) {
    const value = Number.parseInt(firstGroup, 16);

    if (
      Number.isInteger(value) &&
      value >= 0xfe80 &&
      value <= 0xfebf
    ) {
      return true;
    }
  }

  const mappedIpv4 =
    normalized.match(
      /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/,
    )?.[1];

  if (mappedIpv4) {
    return isUnsafeIpv4(mappedIpv4);
  }

  return false;
}

export function isUnsafeIpAddress(
  address: string,
): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isUnsafeIpv4(address);
  }

  if (version === 6) {
    return isUnsafeIpv6(address);
  }

  return true;
}

function isLocalHostname(
  hostname: string,
): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/\.$/, "");

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}

export class SafeUrlPolicy implements UrlPolicy {
  constructor(
    private readonly resolver: HostnameResolver =
      new DnsHostnameResolver(),
  ) {}

  async validate(
    value: unknown,
  ): Promise<string | null> {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 2_048
    ) {
      return null;
    }

    let url: URL;

    try {
      url = new URL(value);
    } catch {
      return null;
    }

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    if (url.username || url.password) {
      return null;
    }

    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");

    if (
      !hostname ||
      isLocalHostname(hostname)
    ) {
      return null;
    }

    const literalVersion = isIP(hostname);

    if (literalVersion !== 0) {
      return isUnsafeIpAddress(hostname)
        ? null
        : url.href;
    }

    try {
      const addresses =
        await this.resolver.resolve(hostname);

      if (
        addresses.length === 0 ||
        addresses.some(({ address }) =>
          isUnsafeIpAddress(address),
        )
      ) {
        return null;
      }
    } catch {
      // Creation fails closed when the destination
      // hostname cannot be resolved safely.
      return null;
    }

    return url.href;
  }
}