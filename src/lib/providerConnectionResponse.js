import { AI_PROVIDERS } from "@/shared/constants/providers";
import { redactSecrets } from "@/lib/secretRedaction";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

// Every secret-named field, at any depth (providerSpecificData included), becomes a
// `has<Field>: true` flag; proxy URLs keep their user but lose the password.
export function toProviderConnectionResponse(connection) {
  if (!connection || typeof connection !== "object") return connection;
  return redactSecrets(connection);
}
