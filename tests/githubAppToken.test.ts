import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createGithubAppJwt,
  mintGithubAppInstallationToken,
} from '../src/githubAppToken.js';

describe('GitHub App token minting', () => {
  it('creates a signed JWT with the app id as issuer', () => {
    const privateKey = testPrivateKey();
    const jwt = createGithubAppJwt({
      appId: '3862765',
      privateKey,
      nowMs: Date.UTC(2026, 4, 26, 12, 0, 0),
    });
    const [, payload] = jwt.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));

    expect(decoded.iss).toBe('3862765');
    expect(decoded.iat).toBe(1779796740);
    expect(decoded.exp).toBe(1779797340);
  });

  it('mints an installation token using the private key command output', async () => {
    const privateKey = testPrivateKey();
    const fetchCalls: Array<{ url: string; authorization: string | null }> = [];
    const result = await mintGithubAppInstallationToken({
      appId: '3862765',
      installationId: '135623998',
      privateKeyCommand: 'vault kv get private_key',
      nowMs: Date.UTC(2026, 4, 26, 12, 0, 0),
      runner: async () => ({ exitCode: 0, stdout: `${privateKey}\n`, stderr: '' }),
      fetchImpl: (async (url, init) => {
        const headers = new Headers(init?.headers);
        fetchCalls.push({
          url: String(url),
          authorization: headers.get('authorization'),
        });
        return new Response(
          JSON.stringify({
            token: 'ghs_installationtoken',
            expires_at: '2026-05-26T12:59:00Z',
          }),
          { status: 201 },
        );
      }) as typeof fetch,
    });

    expect(result).toEqual({
      token: 'ghs_installationtoken',
      expiresAt: '2026-05-26T12:59:00Z',
    });
    expect(fetchCalls[0]?.url).toBe(
      'https://api.github.com/app/installations/135623998/access_tokens',
    );
    expect(fetchCalls[0]?.authorization).toMatch(/^Bearer /);
  });
});

function testPrivateKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs1' })
    .toString();
}
