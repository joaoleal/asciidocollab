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
 * A backslash anywhere in the URL is rejected outright, before any parsing: the WHATWG `URL`
 * parser used below silently rewrites a backslash to a forward slash for special schemes
 * (`http:`/`https:`/...), so `https://github.com\@internal-host/x` parses here as host
 * `github.com` — but git/curl follow RFC 3986, where the backslash has no such meaning and
 * `github.com\` is parsed as literal userinfo, so the connection actually targets
 * `internal-host`. No legitimate git remote host contains a backslash, so rejecting it closes
 * that differential-parsing gap without needing a bespoke RFC-3986 authority parser.
 *
 * @param remoteUrl - The remote URL a git network operation would connect to.
 * @returns The lowercased hostname, or null when no host can be extracted (for example a bare
 *   local filesystem path, or a URL containing a backslash) — callers treat a null host as
 *   deny-by-default.
 */
export function extractRemoteHost(remoteUrl: string): string | null {
  if (remoteUrl.includes('\\')) return null;

  if (remoteUrl.includes('://')) {
    try {
      const { hostname } = new URL(remoteUrl);
      return hostname.length > 0 ? hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  // Conservative fallback, not a full scp-syntax parser: this only needs to recognize the
  // ordinary `[user@]host:path` shape. Anything odder — a second `@`, a bracketed IPv6 literal —
  // either fails to match (denied outright) or yields a garbage "host" string that then fails
  // the allowlist compare; either way it fails safe rather than extracting an attacker-chosen host.
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

/** Parses a colon-separated run of 1-to-4-digit hex hextets into their numeric values, or null if any group is malformed. An empty string yields an empty list (the side of a `::` gap). */
function parseHextetGroup(group: string): number[] | null {
  if (group === '') return [];
  const parsed: number[] = [];
  for (const hextet of group.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
    parsed.push(Number.parseInt(hextet, 16));
  }
  return parsed;
}

/**
 * Expands any valid IPv6 literal — compressed (`::1`), fully written out
 * (`0:0:0:0:0:0:0:1`), zero-padded (`0000:...:0001`), or carrying a trailing dotted-quad IPv4
 * tail (`::ffff:127.0.0.1`) — into its eight numeric hextets, or null when `address` is not a
 * parseable IPv6 literal. Classifying from the parsed hextets rather than the literal's surface
 * form means the DNS-rebinding guard never depends on how the resolver happened to format its
 * answer.
 */
function parseIPv6Hextets(
  address: string,
): [number, number, number, number, number, number, number, number] | null {
  let normalized = address.toLowerCase();

  // Fold a trailing dotted-quad IPv4 tail (the low 32 bits of an IPv4-in-IPv6 embedding) into two
  // hex hextets first, so the remainder is a pure colon-separated hextet string.
  if (normalized.includes('.')) {
    const lastColonIndex = normalized.lastIndexOf(':');
    if (lastColonIndex === -1) return null; // a dotted literal with no colon is not IPv6
    const octets = parseIPv4Octets(normalized.slice(lastColonIndex + 1));
    if (!octets) return null;
    const highGroup = ((octets[0] << 8) | octets[1]).toString(16);
    const lowGroup = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColonIndex + 1)}${highGroup}:${lowGroup}`;
  }

  const compressionParts = normalized.split('::');
  if (compressionParts.length > 2) return null; // at most one `::` gap is legal

  let hextets: number[];
  if (compressionParts.length === 2) {
    const head = parseHextetGroup(compressionParts[0]);
    const tail = parseHextetGroup(compressionParts[1]);
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // a `::` must stand in for at least one all-zero group
    hextets = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  } else {
    const parsed = parseHextetGroup(normalized);
    if (!parsed) return null;
    hextets = parsed;
  }

  if (hextets.length !== 8) return null;
  return [hextets[0], hextets[1], hextets[2], hextets[3], hextets[4], hextets[5], hextets[6], hextets[7]];
}

/**
 * Reports whether a resolved address is a recognizable IPv4 or IPv6 literal at all. An address
 * the parsers cannot make sense of is not something the classifier below can reason about, so the
 * egress guard treats it as un-validatable and rejects it (fail closed) rather than assuming it is
 * a safe public address.
 *
 * @param address - The resolved address literal to classify.
 * @returns True only if `address` parses as a valid IPv4 or IPv6 literal.
 */
export function isRecognizableIpLiteral(address: string): boolean {
  return parseIPv4Octets(address) !== null || parseIPv6Hextets(address) !== null;
}

/**
 * Reports whether a resolved IP address (IPv4 or IPv6, any literal form `dns.lookup` returns)
 * is private, loopback, link-local, or otherwise not a legitimate public remote — the
 * DNS-rebinding guard applied even to an allowlisted hostname.
 *
 * This answers only the private/link-local question for a parseable IP literal; an address that
 * is not a recognizable IP literal returns false here (it is not private) and is rejected
 * separately by the egress guard via {@link isRecognizableIpLiteral}.
 *
 * @param address - The resolved IP address literal.
 * @returns True if the address is private/link-local/loopback/unspecified.
 */
export function isPrivateOrLinkLocalAddress(address: string): boolean {
  const ipv4Octets = parseIPv4Octets(address);
  if (ipv4Octets) return isPrivateOrLinkLocalIPv4(ipv4Octets);

  const hextets = parseIPv6Hextets(address);
  if (!hextets) return false;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = hextets;

  // Link-local and unique-local are decided by the first hextet alone, in any literal form.
  if (first >= 0xFE_80 && first <= 0xFE_BF) return true; // fe80::/10
  if (first >= 0xFC_00 && first <= 0xFD_FF) return true; // fc00::/7

  const highGroupsZero = first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0;
  if (highGroupsZero && sixth === 0 && seventh === 0 && eighth === 0) return true; // unspecified ::
  if (highGroupsZero && sixth === 0 && seventh === 0 && eighth === 1) return true; // loopback ::1

  // IPv4-in-IPv6 embeddings carry an IPv4 in their low 32 bits that a NAT64/translation-capable
  // resolver can route internally, so a private/loopback IPv4 embedded in any of them must be
  // treated as private: IPv4-mapped (`::ffff:0:0/96`), the NAT64 well-known prefix (`64:ff9b::/96`),
  // and the deprecated IPv4-compatible (`::a.b.c.d`) form.
  const isIPv4Mapped = highGroupsZero && sixth === 0xFF_FF;
  const isNat64 = first === 0x00_64 && second === 0xFF_9B && third === 0 && fourth === 0 && fifth === 0 && sixth === 0;
  const isIPv4Compatible = highGroupsZero && sixth === 0;
  if (isIPv4Mapped || isNat64 || isIPv4Compatible) {
    const embeddedIPv4: [number, number, number, number] = [
      (seventh >> 8) & 0xFF,
      seventh & 0xFF,
      (eighth >> 8) & 0xFF,
      eighth & 0xFF,
    ];
    return isPrivateOrLinkLocalIPv4(embeddedIPv4);
  }

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
 * This validates the resolved address at check time only — it does not pin the connection to
 * it. Whatever actually performs the git network operation (`git`/`curl`) re-resolves the
 * hostname independently when it connects, moments later, so a remote that changes its DNS
 * answer between this check and that connection (DNS rebinding) can still reach a different
 * address than the one validated here. Closing that fully requires forcing the eventual
 * connection to the exact address this function validated (for example via a resolve/connect-to
 * override), which is out of scope here; a caller wiring this into a real network operation
 * should either add that pinning or explicitly accept this residual TOCTOU window.
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

  // Fail closed on an empty answer: with no address to validate the DNS-rebinding guard cannot run,
  // so a zero-address result is a rejection rather than a silent pass.
  if (addresses.length === 0) {
    throw new RemoteHostNotAllowedError(`Remote host "${host}" resolved to no addresses.`);
  }

  for (const { address } of addresses) {
    // Fail closed on anything that is not a recognizable IP literal: an address the parsers cannot
    // classify is un-validatable, so it is rejected rather than assumed to be a safe public address.
    if (!isRecognizableIpLiteral(address) || isPrivateOrLinkLocalAddress(address)) {
      throw new RemoteHostNotAllowedError(
        `Remote host "${host}" resolved to a private, link-local, or unrecognized address, which is not permitted.`,
      );
    }
  }
}
