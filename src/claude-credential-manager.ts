import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface StoredClaudeCredential {
  provider: "claude-cli";
  email: string;
  platform: NodeJS.Platform;
  capturedAt: string;
  authStatusText: string;
  credentialSecret: string;
}

export interface ListedClaudeCredential {
  email: string;
  platform: NodeJS.Platform;
  capturedAt: string;
  path: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface AddCredentialOptions {
  storeDir?: string;
  claudeCommand?: string;
  claudeHomeDir?: string;
}

interface ActivateCredentialOptions {
  storeDir?: string;
  claudeHomeDir?: string;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!isEmail(normalized)) {
    throw new Error(`Invalid email address: "${email}"`);
  }
  return normalized;
}

function escapeEmailForFilename(email: string): string {
  return normalizeEmail(email)
    .replace(/@/g, "_at_")
    .replace(/\./g, "_dot_")
    .replace(/[^a-z0-9_]/g, "_");
}

async function runCommand(
  command: string,
  args: string[],
  options: { stdio?: "pipe" | "inherit"; rejectOnFailure?: boolean } = {},
): Promise<CommandResult> {
  const stdio = options.stdio ?? "pipe";
  const rejectOnFailure = options.rejectOnFailure ?? true;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio });
    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && rejectOnFailure) {
        reject(
          new Error(
            `Command failed (${code ?? "unknown"}): ${command} ${args.join(" ")}${stderr ? `\n${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseEmailFromAuthStatus(authStatusText: string): string {
  const match = authStatusText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (!match?.[0]) {
    throw new Error("Could not determine Claude account email from `claude auth status --text` output.");
  }
  return normalizeEmail(match[0]);
}

function resolveClaudeHome(claudeHomeDir?: string): string {
  return claudeHomeDir ?? process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

function resolveLiveCredentialPath(claudeHomeDir?: string): string {
  return join(resolveClaudeHome(claudeHomeDir), ".credentials.json");
}

async function readLiveCredentialSecret(claudeHomeDir?: string): Promise<string> {
  if (process.platform === "darwin") {
    const result = await runCommand("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"]);
    return result.stdout.trim();
  }

  const credentialPath = resolveLiveCredentialPath(claudeHomeDir);
  const value = await readFile(credentialPath, "utf8");
  return value.trim();
}

async function activateLiveCredentialSecret(
  credential: StoredClaudeCredential,
  claudeHomeDir?: string,
): Promise<void> {
  if (process.platform === "darwin") {
    await runCommand(
      "security",
      ["delete-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE],
      { rejectOnFailure: false },
    );
    await runCommand("security", [
      "add-generic-password",
      "-U",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      credential.email,
      "-w",
      credential.credentialSecret,
    ]);
    return;
  }

  const credentialPath = resolveLiveCredentialPath(claudeHomeDir);
  await mkdir(resolveClaudeHome(claudeHomeDir), { recursive: true });
  await writeFile(credentialPath, `${credential.credentialSecret}\n`, { encoding: "utf8", mode: 0o600 });
}

export function defaultClaudeCredentialStoreDir(): string {
  return join(homedir(), ".vibrator", "credentials", "claude");
}

export function credentialFilePathForEmail(email: string, storeDir: string = defaultClaudeCredentialStoreDir()): string {
  return join(storeDir, `${escapeEmailForFilename(email)}.json`);
}

export async function saveClaudeCredential(
  credential: StoredClaudeCredential,
  storeDir: string = defaultClaudeCredentialStoreDir(),
): Promise<string> {
  const email = normalizeEmail(credential.email);
  const path = credentialFilePathForEmail(email, storeDir);
  const payload: StoredClaudeCredential = { ...credential, email };
  await mkdir(storeDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function loadClaudeCredential(
  email: string,
  storeDir: string = defaultClaudeCredentialStoreDir(),
): Promise<StoredClaudeCredential> {
  const path = credentialFilePathForEmail(email, storeDir);
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as StoredClaudeCredential;
  if (
    parsed.provider !== "claude-cli" ||
    typeof parsed.email !== "string" ||
    typeof parsed.platform !== "string" ||
    typeof parsed.capturedAt !== "string" ||
    typeof parsed.authStatusText !== "string" ||
    typeof parsed.credentialSecret !== "string"
  ) {
    throw new Error(`Credential file is invalid: ${path}`);
  }
  return { ...parsed, email: normalizeEmail(parsed.email) };
}

export async function listClaudeCredentials(
  storeDir: string = defaultClaudeCredentialStoreDir(),
): Promise<ListedClaudeCredential[]> {
  let entries: string[];
  try {
    entries = await readdir(storeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const credentials: ListedClaudeCredential[] = [];
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) continue;
    const path = join(storeDir, fileName);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredClaudeCredential>;
    if (
      typeof parsed.email !== "string" ||
      typeof parsed.platform !== "string" ||
      typeof parsed.capturedAt !== "string"
    ) {
      continue;
    }
    credentials.push({
      email: normalizeEmail(parsed.email),
      platform: parsed.platform,
      capturedAt: parsed.capturedAt,
      path,
    });
  }
  return credentials.sort((a, b) => a.email.localeCompare(b.email));
}

export async function removeClaudeCredential(
  email: string,
  storeDir: string = defaultClaudeCredentialStoreDir(),
): Promise<boolean> {
  try {
    await rm(credentialFilePathForEmail(email, storeDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function addClaudeCredential(options: AddCredentialOptions = {}): Promise<StoredClaudeCredential> {
  const claudeCommand = options.claudeCommand ?? "claude";
  await runCommand(claudeCommand, [], { stdio: "inherit" });

  const authStatus = await runCommand(claudeCommand, ["auth", "status", "--text"]);
  const email = parseEmailFromAuthStatus(authStatus.stdout);
  const credentialSecret = await readLiveCredentialSecret(options.claudeHomeDir);

  const credential: StoredClaudeCredential = {
    provider: "claude-cli",
    email,
    platform: process.platform,
    capturedAt: new Date().toISOString(),
    authStatusText: authStatus.stdout.trim(),
    credentialSecret,
  };
  await saveClaudeCredential(credential, options.storeDir);
  return credential;
}

export async function activateClaudeCredential(
  email: string,
  options: ActivateCredentialOptions = {},
): Promise<StoredClaudeCredential> {
  const credential = await loadClaudeCredential(email, options.storeDir);
  await activateLiveCredentialSecret(credential, options.claudeHomeDir);
  return credential;
}
