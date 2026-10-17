/**
 * The in-repo fake Instabox (server/uni/src/instabox/fake.ts) as a process, for the e2e stack.
 * Every machine it "publishes" is the e2e engine, which plays the workspace VM. Operations take
 * a couple of polls so the "Starting your workspace…" steps are visible to the browser.
 */
import { FakeInstabox } from '../server/uni/src/instabox/fake';

const port = Number(process.env.FAKE_INSTABOX_PORT);
const published = process.env.FAKE_PUBLISHED_URL;
if (!port || !published) throw new Error('FAKE_INSTABOX_PORT and FAKE_PUBLISHED_URL are required');

const fake = new FakeInstabox();
fake.pollsToFinish = 2;
fake.publishedUrl = () => published;
await fake.listen(port);
console.log(JSON.stringify({ event: 'fake_instabox_listening', base: fake.base, published }));

const stop = () => void fake.close().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
