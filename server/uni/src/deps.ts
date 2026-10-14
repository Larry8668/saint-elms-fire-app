import type { CoursewareIndex } from './courseware';
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
}
