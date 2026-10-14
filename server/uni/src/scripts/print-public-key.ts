import { loadSigningKeys } from '../signing';

const keys = await loadSigningKeys();
console.log(keys.publicKeyPem);
