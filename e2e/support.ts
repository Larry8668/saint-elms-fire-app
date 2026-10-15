/**
 * Shared constants for the browser harness.
 *
 * The specs skip rather than fail when the university server was not started — a red run on
 * a machine with no database is noise, but a silently-passing run would be worse, so the skip
 * says exactly what is missing. Global setup records that outcome in a status file, because
 * setup and the workers are separate processes and an exported env var does not cross that
 * boundary.
 */

export const UNI_PORT = Number(process.env.E2E_UNI_PORT ?? 4310);
export const UNI_URL = `http://127.0.0.1:${UNI_PORT}`;
