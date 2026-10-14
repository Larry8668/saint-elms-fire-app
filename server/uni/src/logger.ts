import { createLogger } from '@sef/shared';

export { errorFields } from '@sef/shared';
export const log = createLogger('uni', process.env.LOG_LEVEL === 'debug');
