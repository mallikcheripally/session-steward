import { codexProvider } from "./codex/index.mjs";
import { claudeCodeProvider } from "./claude-code/index.mjs";

const providers = Object.freeze([codexProvider, claudeCodeProvider]);
const providersById = new Map(providers.map((provider) => [provider.id, provider]));

export function getProvider(providerId) {
  const provider = providersById.get(providerId);

  if (!provider) {
    throw new Error(`Unsupported provider: ${providerId}`);
  }

  return provider;
}

export function listProviders() {
  return [...providers];
}
