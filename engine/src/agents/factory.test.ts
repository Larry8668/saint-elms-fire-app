import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import type { ResolvedModel } from '../models/registry';
import { generateStructured } from './factory';

/** A fake Ollama that streams whatever raw JSON text the test hands it, the way a model writes it. */
let server: Server;
let reply = '';
let base = '';

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const half = Math.ceil(reply.length / 2);
      res.write(`${JSON.stringify({ message: { content: reply.slice(0, half) }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { content: reply.slice(half) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const resolved = () => ({ provider: { kind: 'ollama', baseUrl: base }, modelId: 'fake', providerOptions: {} }) as unknown as ResolvedModel;
const Reading = z.object({ transcription: z.string() });

test('a model writing single-backslash LaTeX gets its formulas back intact through the Ollama path', async () => {
  reply = String.raw`{"transcription": "Incline at $30^\text{o}$; $N = mg\cos\theta$; $\alpha = \frac{\Delta\omega}{\Delta t}$"}`;
  const { object } = await generateStructured({ agentId: 'notes-reader', instructions: 'read', prompt: 'read', resolved: resolved(), schema: Reading });
  assert.equal(object.transcription, String.raw`Incline at $30^\text{o}$; $N = mg\cos\theta$; $\alpha = \frac{\Delta\omega}{\Delta t}$`);
});

test('well-formed output with ordinary escapes parses exactly as before', async () => {
  reply = '{"transcription": "Line one\\nThe second line \\"quoted\\""}';
  const { object } = await generateStructured({ agentId: 'notes-reader', instructions: 'read', prompt: 'read', resolved: resolved(), schema: Reading });
  assert.equal(object.transcription, 'Line one\nThe second line "quoted"');
});
