import dns from 'node:dns/promises';

/**
 * Git provider hostnames the network egress allowlist covers without any operator
 * configuration — the same three providers `git.egress.allowedHosts` defaults to.
 */
export const DEFAULT_ALLOWED_GIT_HOSTS: readonly string[] = ['github.com', 'gitlab.com', 'bitbucket.org'];

/**
 * Raised when a git remote's host is rejected by the network egress allowlist: either the
 * host itself is not configured, or (closing a DNS-rebinding path around an otherwise-allowed
 * hostname) it resolves to a private or link-local address. Always raised before any `git`
 * network process is spawned, so a rejected remote is never actually contacted.
 */
export class RemoteHostNotAllowedError extends Error {
  /** @param message - A safe, human-readable description of why the remote host was rejected. */
  constructor(message: string) {
    super(message);
    this.name = 'RemoteHostNotAllowedError';
  }
}

/** One address a hostname resolved to, as returned by a {@link HostAddressResolver}. */
export interface ResolvedHostAddress {
  /** The resolved IPv4 or IPv6 literal. */
  readonly address: string;
}

/** Resolves a hostname to every address it currently answers to. */
export type HostAddressResolver = (host: string) => Promise<readonly ResolvedHostAddress[]>;

/**
 * Extracts the hostname a git remote URL would connect to — covering both a normal
 * `scheme://[user@]host[:port]/path` URL and the scp-like shorthand `[user@]host:path` git
 * also accepts as a remote (no scheme, no `://`).
 *
 * @param remoteUrl - The remote URL a git network operation would connect to.
 * @returns The lowercased hostname, or null when no host can be extracted (for example a bare
 *   local filesystem path) — callers treat a null host as deny-by-default.
 */
export function extractRemoteHost(remoteUrl: string): string | null {
  if (remoteUrl.includes('://')) {
    try {
      const { hostname } = new URL(remoteUrl);
      return hostname.length > 0 ? hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  const scpLikeMatch = /^(?:[^@/]+@)?([^:/]+):/.exec(remoteUrl);
  return scpLikeMatch ? scpLikeMatch[1].toLowerCase() : null;
}

/**
 * Checks a hostname against the configured allowlist, case-insensitively and by exact match
 * only — no wildcards or subdomain matching, so an operator who wants to permit a subdomain
 * lists it explicitly.
 *
 * @param host - The hostname to check.
 * @param allowedHosts - The configured egress allowlist (`git.egress.allowedHosts`).
 * @returns True if `host` is present in `allowedHosts`.
 */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const normalizedHost = host.toLowerCase();
  return allowedHosts.some((allowedHost) => allowedHost.toLowerCase() === normalizedHost);
}

/** Parses a dotted-decimal IPv4 literal into its four octets, or null if `address` is not one. */
function parseIPv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return [octets[0], octets[1], octets[2], octets[3]];
}

/** Reports whether an IPv4 address (given as its four octets) is private, loopback, or link-local. */
function isPrivateOrLinkLocalIPv4([a, b]: readonly [number, number, number, number]): boolean {
  if (a === 0) return true; // "this network" (RFC 791)
  if (a === 10) return true; // RFC 1918 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (includes the cloud metadata address)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 private
  if (a === 192 && b === 168) return true; // RFC 1918 private
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space / CGNAT (RFC 6598)
  return false;
}

/**
 * Reports whether a resolved IP address (IPv4 or IPv6, any literal form `dns.lookup` returns)
 * is private, loopback, link-local, or otherwise not a legitimate public remote — the
 * DNS-rebinding guard applied even to an allowlisted hostname.
 *
 * @param address - The resolved IP address literal.
 * @returns True if the address is private/link-local/loopback/unspecified.
 */
export function isPrivateOrLinkLocalAddress(address: string): boolean {
  const ipv4Octets = parseIPv4Octets(address);
  if (ipv4Octets) return isPrivateOrLinkLocalIPv4(ipv4Octets);

  const lowerAddress = address.toLowerCase();
  if (lowerAddress === '::1' || lowerAddress === '::') return true; // loopback / unspecified

  if (lowerAddress.startsWith('::ffff:')) {
    const mappedOctets = parseIPv4Octets(lowerAddress.slice('::ffff:'.length));
    if (mappedOctets) return isPrivateOrLinkLocalIPv4(mappedOctets);
  }

  const firstHextet = lowerAddress.startsWith('::') ? 0 : Number.parseInt(lowerAddress.split(':')[0], 16);
  if (Number.isNaN(firstHextet)) return false;
  if (firstHextet >= 0xFE_80 && firstHextet <= 0xFE_BF) return true; // link-local fe80::/10
  if (firstHextet >= 0xFC_00 && firstHextet <= 0xFD_FF) return true; // unique local fc00::/7
  return false;
}

/** The real {@link HostAddressResolver}: Node's own DNS resolution. */
async function lookupHostAddresses(host: string): Promise<readonly ResolvedHostAddress[]> {
  return dns.lookup(host, { all: true });
}

/**
 * Enforces the network egress allowlist for a git remote: deny-by-default unless `remoteUrl`'s
 * host is present in `allowedHosts`, AND (closing DNS-rebinding around an allowlisted hostname)
 * its resolved addresses are not private/link-local. The host check runs first and rejects
 * before any DNS resolution is attempted, so a disallowed host never causes any network activity
 * at all.
 *
 * @param remoteUrl - The remote URL a git network operation is about to contact.
 * @param allowedHosts - The configured egress allowlist (`git.egress.allowedHosts`).
 * @param resolveHost - Resolves a hostname to its addresses; defaults to real DNS resolution —
 *   overridable so a caller can simulate resolution without a real DNS lookup.
 * @returns Resolves if the remote host is allowed and safe to contact; otherwise rejects.
 * @throws {RemoteHostNotAllowedError} If the host is not allowlisted, cannot be resolved, or
 *   resolves to a private/link-local address.
 */
export async function assertRemoteHostAllowed(
  remoteUrl: string,
  allowedHosts: readonly string[],
  resolveHost: HostAddressResolver = lookupHostAddresses,
): Promise<void> {
  const host = extractRemoteHost(remoteUrl);
  if (host === null || !isHostAllowed(host, allowedHosts)) {
    throw new RemoteHostNotAllowedError(
      `Remote host "${host ?? remoteUrl}" is not in the configured git egress allowlist.`,
    );
  }

  let addresses: readonly ResolvedHostAddress[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new RemoteHostNotAllowedError(`Remote host "${host}" could not be resolved.`);
  }

  for (const { address } of addresses) {
    if (isPrivateOrLinkLocalAddress(address)) {
      throw new RemoteHostNotAllowedError(
        `Remote host "${host}" resolved to a private or link-local address, which is not permitted.`,
      );
    }
  }
}
