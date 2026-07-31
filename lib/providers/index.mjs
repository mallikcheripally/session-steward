import { codexProvider } from "./codex/index.mjs";

const providers = Object.freeze([codexProvider]);
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
