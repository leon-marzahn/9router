// Provider credentials are stored encrypted (AES-256-GCM envelopes, see
// src/lib/credentials/): every credential field in providerConnections.data,
// proxyPools.data and settings.data becomes "enc:v1:<keyId>:<iv>:<tag>:<ct>".
// One-way for older versions: they would send the envelope upstream as the credential.
// migrate.js loads the key (fail closed) and takes the required, pinned
// pre-encrypt-credentials backup before this runs, then VACUUMs once it has.
// Idempotent: values already under the current key are skipped.
import { getKeyring } from "@/lib/credentials/keyring.js";
import { sealAllCredentials } from "../helpers/credentialsSeal.js";

const encryptCredentials = {
  version: 6,
  name: "encrypt-credentials",
  up(db) {
    sealAllCredentials(db, getKeyring());
  },
};

export default encryptCredentials;
