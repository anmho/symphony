import { createSign } from 'node:crypto';
import { runShellCommand, type CommandResult } from './process.js';
import { redactSecretLikeText } from './prIdentity.js';

type Fetch = typeof fetch;

export interface MintGithubAppInstallationTokenInput {
  appId: string;
  installationId: string;
  privateKeyCommand: string;
  runner?: (
    command: string,
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => Promise<CommandResult>;
  fetchImpl?: Fetch;
  nowMs?: number;
}

export interface GithubAppInstallationToken {
  token: string;
  expiresAt: string;
}

export async function mintGithubAppInstallationToken(
  input: MintGithubAppInstallationTokenInput,
): Promise<GithubAppInstallationToken> {
  const runner = input.runner ?? runShellCommand;
  const result = await runner(input.privateKeyCommand, { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `github_app_private_key_command_failed: ${redactSecretLikeText(result.stderr || result.stdout)}`,
    );
  }

  const privateKey = result.stdout.trimEnd();
  if (!privateKey) {
    throw new Error('github_app_private_key_empty');
  }

  const jwtInput: { appId: string; privateKey: string; nowMs?: number } = {
    appId: input.appId,
    privateKey,
  };
  if (input.nowMs !== undefined) {
    jwtInput.nowMs = input.nowMs;
  }
  const jwt = createGithubAppJwt(jwtInput);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'user-agent': '@anmho/symphony',
        'x-github-api-version': '2022-11-28',
      },
    },
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `github_app_installation_token_failed: ${response.status} ${redactSecretLikeText(body)}`,
    );
  }

  const parsed = JSON.parse(body) as { token?: string; expires_at?: string };
  if (!parsed.token || !parsed.expires_at) {
    throw new Error('github_app_installation_token_incomplete');
  }
  return {
    token: parsed.token,
    expiresAt: parsed.expires_at,
  };
}

export function createGithubAppJwt(input: {
  appId: string;
  privateKey: string;
  nowMs?: number;
}): string {
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: input.appId,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(input.privateKey, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.${signature}`;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
