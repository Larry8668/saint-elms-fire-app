import { BookLock, MessageSquareWarning } from 'lucide-react';
import { Badge, Panel } from '@/components/ui/primitives';
import { admissionOf, type AdmissionState } from '@/features/auth/admission';
import type { DeviceProfile } from '@sef/shared';

/**
 * Academic fields the university publishes per programme row. None of these reach this device:
 * they live in the admission-gated `GET /v1/programme` record, and the local engine does not
 * carry that record yet. Listing them is what stops the released view being mistaken for the
 * whole curriculum.
 */
const UNAVAILABLE_FIELDS = [
  'Credits and hours per week',
  'Course type, delivery mode and academic status',
  'Source status for external and internship-workflow rows',
  'Elective option groups and the bundles a valid selection may be made from',
] as const;

/**
 * What the university is told when this record is refused. It is a real response, not a
 * guess: `GET /v1/programme` answers an unsigned-in or unapproved caller with 403, and an
 * approved student is the only student who may read the full structure.
 */
const GATE_NOTE =
  'The university releases this record to approved students and to staff. Anyone else gets a 403 rather than a partial curriculum.';

const ADMISSION_NOTE: Partial<Record<AdmissionState, string>> = {
  pending: 'Your application is still with the registrar. Ask your registrar when it is approved — the programme record unlocks then, and not before.',
  legacy: 'This device profile predates university admission checks, so the programme record is not available to it.',
};

/**
 * The full curriculum is genuinely unavailable here, and this says so rather than drawing an
 * empty curriculum. A plausible-looking fake would be worse than an honest gap.
 */
export function CurriculumUnavailable({ profile }: { profile: DeviceProfile }) {
  const admission = admissionOf(profile);
  const note = ADMISSION_NOTE[admission];

  return (
    <Panel className="mb-6 border-ember-400/20 p-5">
      <div className="flex items-start gap-3">
        <BookLock aria-hidden className="mt-0.5 size-5 shrink-0 text-ember-400" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-night-100">Full curriculum not available here</h2>
            <Badge tone="ember">Not a gap in your record</Badge>
          </div>
          <p className="mt-2 text-[13.5px] leading-6 text-night-300">
            What you can see below is everything released to your cohort. The published programme structure is held by the
            university and is not carried by this device yet, so it is left out rather than estimated.
          </p>

          <dl className="mt-4 space-y-3">
            <div>
              <dt className="text-[12px] font-semibold tracking-wide text-night-400 uppercase">Not shown here</dt>
              <dd className="mt-1.5">
                <ul className="space-y-1">
                  {UNAVAILABLE_FIELDS.map((field) => (
                    <li key={field} className="flex items-start gap-2 text-[13px] leading-5 text-night-400">
                      <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-night-600" />
                      {field}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt className="text-[12px] font-semibold tracking-wide text-night-400 uppercase">Why</dt>
              <dd className="mt-1.5 flex items-start gap-2 text-[13px] leading-5 text-night-400">
                <MessageSquareWarning aria-hidden className="mt-0.5 size-4 shrink-0 text-beacon-300" />
                <span>
                  {GATE_NOTE} {note ?? 'If your enrolment is not approved yet, ask your registrar when it will be.'}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </Panel>
  );
}