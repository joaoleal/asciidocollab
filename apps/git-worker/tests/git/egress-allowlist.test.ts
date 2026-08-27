import {
  DEFAULT_ALLOWED_GIT_HOSTS,
  RemoteHostNotAllowedError,
  assertRemoteHostAllowed,
  extractRemoteHost,
  isHostAllowed,
  isPrivateOrLinkLocalAddress,
} from '../../src/git/egress-allowlist.js';

describe('extractRemoteHost', () => {
  it('extracts the host from an https URL', () => {
    expect(extractRemoteHost('https://github.com/org/repo.git')).toBe('github.com');
  });

  it('extracts the host from an ssh:// URL, ignoring the user and port', () => {
    expect(extractRemoteHost('ssh://git@example.com:2222/org/repo.git')).toBe('example.com');
  });

  it('extracts the host from scp-like shorthand (user@host:path, no scheme)', () => {
    expect(extractRemoteHost('git@github.com:org/repo.git')).toBe('github.com');
  });

  it('lowercases the extracted host', () => {
    expect(extractRemoteHost('https://GitHub.COM/org/repo.git')).toBe('github.com');
  });

  it('returns null for a bare local filesystem path', () => {
    expect(extractRemoteHost('/var/repos/example.git')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(extractRemoteHost('https://')).toBeNull();
  });

  describe('differential-parsing safety (host must match what git/curl would actually contact)', () => {
    it('rejects a backslash-crafted URL targeting a private address behind an allowlisted-looking prefix', () => {
      // WHATWG URL treats \ as a path separator for http(s), so a naive parse would read this as
      // host "github.com" — but git/curl (RFC 3986) read "github.com\" as userinfo and connect to
      // 169.254.169.254. Must be denied outright, not misread as the allowlisted host.
      expect(extractRemoteHost(String.raw`https://github.com\@169.254.169.254/repo.git`)).toBeNull();
    });

    it('rejects a backslash-crafted URL targeting an arbitrary host behind an allowlisted-looking prefix', () => {
      expect(extractRemoteHost(String.raw`https://github.com\@evil-host.example/repo.git`)).toBeNull();
    });

    it('extracts the real (post-@) host, not the decoy, when the URL has multiple @ characters', () => {
      expect(extractRemoteHost('https://github.com@evil.example/repo.git')).toBe('evil.example');
    });

    it('extracts the real host across an embedded tab/newline/carriage-return before the final @', () => {
      expect(extractRemoteHost('https://github.com\t@evil.example/repo.git')).toBe('evil.example');
      expect(extractRemoteHost('https://github.com\n@evil.example/repo.git')).toBe('evil.example');
      expect(extractRemoteHost('https://github.com\r@evil.example/repo.git')).toBe('evil.example');
    });
  });
});

describe('isHostAllowed', () => {
  it('permits a host present in the allowlist', () => {
    expect(isHostAllowed('github.com', ['github.com', 'gitlab.com'])).toBe(true);
  });

  it('rejects a host absent from the allowlist', () => {
    expect(isHostAllowed('internal.example.net', ['github.com', 'gitlab.com'])).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isHostAllowed('GitHub.com', ['github.com'])).toBe(true);
  });

  it('does not match a subdomain of an allowed host', () => {
    expect(isHostAllowed('evil.github.com', ['github.com'])).toBe(false);
  });
});

describe('DEFAULT_ALLOWED_GIT_HOSTS', () => {
  it('resolves the supported provider defaults (GitHub, GitLab, Bitbucket)', () => {
    expect(isHostAllowed('github.com', DEFAULT_ALLOWED_GIT_HOSTS)).toBe(true);
    expect(isHostAllowed('gitlab.com', DEFAULT_ALLOWED_GIT_HOSTS)).toBe(true);
    expect(isHostAllowed('bitbucket.org', DEFAULT_ALLOWED_GIT_HOSTS)).toBe(true);
  });

  it('does not resolve an unrelated host', () => {
    expect(isHostAllowed('example.com', DEFAULT_ALLOWED_GIT_HOSTS)).toBe(false);
  });
});

describe('isPrivateOrLinkLocalAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata address
    ['100.64.0.1', true], // CGNAT shared address space
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['172.32.0.1', false], // just outside the 172.16.0.0/12 private range
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true], // loopback fully written out (uncompressed)
    ['0000:0000:0000:0000:0000:0000:0000:0001', true], // loopback, zero-padded
    ['::', true], // unspecified, compressed
    ['0:0:0:0:0:0:0:0', true], // unspecified fully written out
    ['fe80::1', true],
    ['FE80:0:0:0:0:0:0:1', true], // link-local, uppercase and uncompressed
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['::ffff:a9fe:a9fe', true], // IPv4-mapped metadata address written as hex hextets (169.254.169.254)
    ['64:ff9b::7f00:1', true], // NAT64 well-known prefix embedding 127.0.0.1 as hextets
    ['64:ff9b::127.0.0.1', true], // NAT64 well-known prefix embedding loopback, dotted
    ['64:ff9b::8.8.8.8', false], // NAT64 of a public IPv4 stays public
    ['::7f00:1', true], // deprecated IPv4-compatible form embedding 127.0.0.1
    ['::127.0.0.1', true], // deprecated IPv4-compatible form embedding loopback, dotted
    ['::2:3:4:5', false], // `::`-leading but the tail is not an embedded IPv4 — not classified private
    ['::ffff:7f00:1', true], // IPv4-mapped loopback written as hex hextets (127.0.0.1)
    ['2001:4860:4860::8888', false],
    ['2606:4700:4700::1111', false], // public IPv6 stays public regardless of literal form
  ])('classifies %s as private/link-local: %s', (address, expected) => {
    expect(isPrivateOrLinkLocalAddress(address)).toBe(expected);
  });
});

describe('assertRemoteHostAllowed', () => {
  it('permits a remote whose host is on the allowlist and resolves to a public address', async () => {
    const resolveHost = jest.fn().mockResolvedValue([{ address: '93.184.216.34' }]);

    await expect(
      assertRemoteHostAllowed('https://git.example.com/org/repo.git', ['git.example.com'], resolveHost),
    ).resolves.toBeUndefined();
    expect(resolveHost).toHaveBeenCalledWith('git.example.com');
  });

  it('rejects a remote whose host is not on the allowlist, before attempting any resolution', async () => {
    const resolveHost = jest.fn().mockResolvedValue([{ address: '93.184.216.34' }]);

    await expect(
      assertRemoteHostAllowed('https://not-allowed.example.com/org/repo.git', ['git.example.com'], resolveHost),
    ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('rejects an allowlisted host that resolves to a private address (DNS-rebinding guard)', async () => {
    const resolveHost = jest.fn().mockResolvedValue([{ address: '10.0.0.5' }]);

    await expect(
      assertRemoteHostAllowed('https://git.example.com/org/repo.git', ['git.example.com'], resolveHost),
    ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
  });

  it('permits an allowlisted host that resolves to a public IPv6 address', async () => {
    const resolveHost = jest.fn().mockResolvedValue([{ address: '2606:4700:4700::1111' }]);

    await expect(
      assertRemoteHostAllowed('https://git.example.com/org/repo.git', ['git.example.com'], resolveHost),
    ).resolves.toBeUndefined();
  });

  it('rejects when the resolver returns no addresses (cannot validate, deny by default)', async () => {
    const resolveHost = jest.fn().mockResolvedValue([]);

    await expect(
      assertRemoteHostAllowed('https://git.example.com/org/repo.git', ['git.example.com'], resolveHost),
    ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
    expect(resolveHost).toHaveBeenCalledWith('git.example.com');
  });

  it.each([['not-an-ip'], ['999.999.999.999'], ['::gggg']])(
    'rejects an allowlisted host that resolves to an unparseable address literal (%s)',
    async (address) => {
      const resolveHost = jest.fn().mockResolvedValue([{ address }]);

      await expect(
        assertRemoteHostAllowed('https://git.example.com/org/repo.git', ['git.example.com'], resolveHost),
      ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
    },
  );

  it('rejects when only some resolved addresses are unparseable (all must be recognizable public IPs)', async () => {
    const resolveHost = jest.fn().mockResolvedValue([{ address: '93.184.216.34' }, { address: 'not-an-ip' }]);

    await expect(
      assertRemoteHostAllowed('https://git.example.com/org/repo.git', ['git.example.com'], resolveHost),
    ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
  });

  it('rejects when the host cannot be resolved at all', async () => {
    const resolveHost = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));

    await expect(
      assertRemoteHostAllowed('https://git.example.com/org/repo.git', ['git.example.com'], resolveHost),
    ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
  });

  it('rejects a remote with no extractable host', async () => {
    const resolveHost = jest.fn().mockResolvedValue([{ address: '93.184.216.34' }]);

    await expect(assertRemoteHostAllowed('/var/repos/example.git', ['git.example.com'], resolveHost)).rejects.toBeInstanceOf(
      RemoteHostNotAllowedError,
    );
  });

  it('rejects a backslash-crafted URL even when the allowlist contains the decoy prefix host, and never resolves', async () => {
    const resolveHost = jest.fn().mockResolvedValue([{ address: '93.184.216.34' }]);

    await expect(
      assertRemoteHostAllowed(String.raw`https://github.com\@169.254.169.254/repo.git`, ['github.com'], resolveHost),
    ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
    await expect(
      assertRemoteHostAllowed(String.raw`https://github.com\@evil-host.example/repo.git`, ['github.com'], resolveHost),
    ).rejects.toBeInstanceOf(RemoteHostNotAllowedError);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(resolveHost).not.toHaveBeenCalled();
  });

  describe('with the real default resolver (no injected resolveHost)', () => {
    it('permits an allowlisted host that is itself a public IP literal', async () => {
      await expect(assertRemoteHostAllowed('https://93.184.216.34/org/repo.git', ['93.184.216.34'])).resolves.toBeUndefined();
    });

    it('rejects an allowlisted host that is itself a private IP literal', async () => {
      await expect(assertRemoteHostAllowed('https://10.0.0.5/org/repo.git', ['10.0.0.5'])).rejects.toBeInstanceOf(
        RemoteHostNotAllowedError,
      );
    });
  });
});
