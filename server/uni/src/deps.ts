import type { CoursewareIndex, ProgrammeManifestResult } from './courseware';
import type { CourseAvailability } from '@sef/shared';
import type { Pool } from 'pg';
import type { AccountAuth } from './account-auth';
import type { SessionOrchestrator } from './sessions/orchestrator';
import type { SigningKeys } from './signing';
import type { AccountStore } from './store/accounts';
import type { AuditLog } from './store/audit';
import type { DispersalStore } from './store/dispersal';
import type { ReleaseStore } from './store/releases';
import type { ShareStore } from './store/shares';

export interface UniDeps {
  courseware: CoursewareIndex;
  releases: ReleaseStore;
  keys: SigningKeys;
  shares: ShareStore;
  accounts: AccountStore;
  audit: AuditLog;
  dispersal: DispersalStore;
  /** Normalized programme manifest; null only when the manifest is absent or invalid. */
  programme?: ProgrammeManifestResult | null;
  /** Content/release/selection per row, derived from the content tree at boot. */
  availability?: Record<string, CourseAvailability>;
  /** better-auth account endpoints; absent when the deployment has no database configured. */
  accountAuth?: AccountAuth | null;
  /** Admission/staff persistence; absent without UNI_DATABASE_URL (routes fail closed). */
  pool?: Pool;
  /** Per-login Instabox VMs (PR-42); absent unless INSTABOX_API_KEY and SEF_GOLDEN_SNAPSHOT_ID are set. */
  sessions?: SessionOrchestrator | null;
  /** Overrides `config.seedDemo` (tests); demo personas' legacy tokens may use Peers only when true. */
  seedDemo?: boolean;
}
