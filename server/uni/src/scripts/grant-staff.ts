/**
 * Operator-only staff bootstrap: grants a staff membership to an already-registered,
 * email-verified account. There is deliberately no HTTP path for the first grant —
 * the operator needs UNI_DATABASE_URL, which only a server operator should hold.
 *
 *   UNI_DATABASE_URL=postgres://… pnpm --filter @sef/uni-server staff:grant -- --email ops@uni.edu --role owner
 */
import { closeDatabasePool, createDatabasePool, parseDatabaseConfig } from '../db';
import { AdmissionError } from '../enrolments';
import { grantStaffMembership } from '../staff';

function parseArgs(argv: string[]): { email: string; role: 'owner' | 'registrar' | 'lecturer' | 'support' } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i]?.startsWith('--')) args.set(argv[i]!.slice(2), argv[i + 1] ?? '');
  }
  const email = args.get('email')?.trim();
  const role = args.get('role') ?? 'owner';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email is required');
  if (!['owner', 'registrar', 'lecturer', 'support'].includes(role)) {
    throw new Error('--role must be owner, registrar, lecturer or support');
  }
  return { email, role: role as 'owner' | 'registrar' | 'lecturer' | 'support' };
}

async function main() {
  const { email, role } = parseArgs(process.argv.slice(2));
  if (!process.env.UNI_DATABASE_URL?.trim()) throw new Error('UNI_DATABASE_URL is required');
  const pool = createDatabasePool(parseDatabaseConfig());
  try {
    const membership = await grantStaffMembership(pool, { email, role, actor: 'operator-cli' });
    console.log(`staff_granted role=${membership.role} subject=${membership.staff_subject} status=${membership.status}`);
  } catch (error) {
    if (error instanceof AdmissionError) throw new Error(`staff grant failed: ${error.message}`);
    throw error;
  } finally {
    await closeDatabasePool(pool);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
