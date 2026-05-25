import {
  activateClaudeCredential,
  addClaudeCredential,
  defaultClaudeCredentialStoreDir,
  listClaudeCredentials,
  removeClaudeCredential,
} from "./claude-credential-manager.js";

function usage(): string {
  return [
    "Usage:",
    "  tsx src/claude-credential-cli.ts add",
    "  tsx src/claude-credential-cli.ts list",
    "  tsx src/claude-credential-cli.ts remove <email>",
    "  tsx src/claude-credential-cli.ts activate <email>",
  ].join("\n");
}

async function run(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case "add": {
      console.log("Starting Claude login flow. Complete authentication in Claude, then exit.");
      const credential = await addClaudeCredential();
      console.log(`Saved Claude credential for ${credential.email} in ${defaultClaudeCredentialStoreDir()}`);
      return;
    }
    case "list": {
      const credentials = await listClaudeCredentials();
      if (credentials.length === 0) {
        console.log(`No Claude credentials found in ${defaultClaudeCredentialStoreDir()}`);
        return;
      }
      for (const credential of credentials) {
        console.log(`${credential.email}\t${credential.platform}\t${credential.capturedAt}`);
      }
      return;
    }
    case "remove": {
      if (!argument) {
        throw new Error("Missing email argument for remove.");
      }
      const removed = await removeClaudeCredential(argument);
      if (removed) {
        console.log(`Removed Claude credential: ${argument}`);
      } else {
        console.log(`No Claude credential found for: ${argument}`);
      }
      return;
    }
    case "activate": {
      if (!argument) {
        throw new Error("Missing email argument for activate.");
      }
      const credential = await activateClaudeCredential(argument);
      console.log(`Activated Claude credential for ${credential.email}`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}\n\n${usage()}`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (!message.includes("Usage:")) {
    console.error(`\n${usage()}`);
  }
  process.exitCode = 1;
});
