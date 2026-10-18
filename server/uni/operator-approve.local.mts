// Operator-side admission for the hosted uni, run from the laptop with the external DB URL:
//   list                      -> the latest enrolments (id, status, version, cohort)
//   approve <enrolmentId> <v> -> approve into the 2026 intake (Semester 1) at expected version v
// Uses the uni's own enrolments module, so audit rows and state rules apply as on the server.
import { closeDatabasePool, createDatabasePool, parseDatabaseConfig } from './src/db';
import { decideEnrolment } from './src/enrolments';
import { CONTRACT_VERSION } from '@sef/shared';

const [mode, id, version] = process.argv.slice(2);
const pool = createDatabasePool(parseDatabaseConfig());
try {
  if (mode === 'list') {
    const r = await pool.query(
      `SELECT e.id, e.status, e.version, e.cohort_code, e.programme_code, e.requested_at, u.email
         FROM enrolments e
         LEFT JOIN student_profiles p ON p.id = e.student_profile_id
         LEFT JOIN "user" u ON u.id = p.account_user_id
        ORDER BY e.requested_at DESC LIMIT 5`,
    );
    for (const row of r.rows) console.log(row.id, row.status, 'v' + row.version, row.cohort_code ?? '-', row.programme_code, (row.email ?? '?').replace(/(.).+(@.+)/, '$1***$2'));
  } else if (mode === 'approve' && id && version) {
    const e = await decideEnrolment(pool, {
      enrolmentId: id,
      actor: 'operator-cli',
      request: { schemaVersion: CONTRACT_VERSION, expectedVersion: Number(version), action: 'approve', reason: 'demo-day operator approval', cohortId: 'bsc-pma-2026' },
    });
    console.log('approved', e.id, e.status, 'cohort', e.cohortId);
  } else {
    console.log('usage: list | approve <enrolmentId> <expectedVersion>');
  }
} finally {
  await closeDatabasePool(pool);
}
