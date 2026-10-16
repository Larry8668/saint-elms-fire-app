import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeImageDimensions } from './image';

/** A minimal PNG: signature, then an IHDR chunk carrying the given dimensions. */
const png = (width: number, height: number): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]);
};

/** A minimal JPEG: SOI, one APP0 segment, then a SOF0 segment with the given dimensions. */
const jpeg = (width: number, height: number): Buffer => {
  const app0Payload = Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1');
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(app0Payload.length + 2, 0); return b; })(), app0Payload]);
  const sofPayload = Buffer.alloc(15);
  sofPayload[0] = 8; // precision
  sofPayload.writeUInt16BE(height, 1);
  sofPayload.writeUInt16BE(width, 3);
  sofPayload[5] = 3; // components
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(sofPayload.length + 2, 0); return b; })(), sofPayload]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
};

test('PNG dimensions come from the IHDR header, not the declared type', () => {
  assert.deepEqual(probeImageDimensions(png(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(probeImageDimensions(png(9000, 9000)), { width: 9000, height: 9000 });
});

test('JPEG dimensions come from the first start-of-frame segment', () => {
  assert.deepEqual(probeImageDimensions(jpeg(1024, 768)), { width: 1024, height: 768 });
});

test('a JPEG with fill bytes and a DHT segment before the frame is still read', () => {
  const dht = Buffer.concat([Buffer.from([0xff, 0xc4]), Buffer.from([0x00, 0x04]), Buffer.from([0x00, 0x00])]);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xff]), dht, jpeg(640, 480).subarray(2)]);
  assert.deepEqual(probeImageDimensions(bytes), { width: 640, height: 480 });
});

test('anything without a readable header answers null, never a guessed size', () => {
  assert.equal(probeImageDimensions(Buffer.from('iVBORw0KGgo=', 'base64')), null, 'the 8-byte signature alone is not a header');
  assert.equal(probeImageDimensions(Buffer.from('not an image at all', 'utf8')), null);
  assert.equal(probeImageDimensions(new Uint8Array(0)), null);
  const wrongChunk = png(800, 600);
  wrongChunk[12] = 0x58; // 'XHDR' is not IHDR
  assert.equal(probeImageDimensions(wrongChunk), null);
  const truncatedJpeg = jpeg(640, 480).subarray(0, 10);
  assert.equal(probeImageDimensions(truncatedJpeg), null);
});
