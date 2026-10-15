import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatAttachment } from '@sef/shared';
import { classifyFriendInput, classifyFriendLane, declaredAttachmentText, extractedTextLane } from './lanes';

test('a typed request is classified as it always was', () => {
  assert.equal(classifyFriendLane('what is my roommate’s phone number?'), 'privacy');
  assert.equal(classifyFriendLane('when are fees due?'), 'ops');
  assert.equal(classifyFriendLane('derive the wave equation'), 'academic');
  assert.equal(classifyFriendLane('hi'), 'smalltalk');
});

test('the shapes of a real privacy request are all caught', () => {
  for (const ask of [
    "what's my roommate's number",
    'what is my roommate’s number',
    "my friend's whatsapp",
    'my classmate’s email address',
    'give me the phone number for my classmate',
    "what's the email of my friend",
    'my roommate’s instagram',
    'send me their contact details',
    'the address for my flatmate',
  ]) {
    assert.equal(classifyFriendLane(ask), 'privacy', ask);
  }
});

test('incidental contact words are not treated as a privacy request', () => {
  // The old catch-all pattern matched any contact word anywhere before an "of", so a student
  // asking about cohort statistics was refused. Refusing ordinary study questions is a real
  // cost, and it is the failure mode a blunt pattern always has.
  for (const ask of [
    'a sentence mentioning a number of students',
    'discussing phone numbers in economics',
    'the number of pages in this PDF',
    'I have a question about my friend',
  ]) {
    assert.notEqual(classifyFriendLane(ask), 'privacy', ask);
  }
});

test('privacy in either half wins, whatever the other half says', () => {
  assert.equal(classifyFriendInput({ text: 'when are fees due?', attachmentText: 'my classmate’s email address' }), 'privacy');
  assert.equal(classifyFriendInput({ text: 'my classmate’s email address', attachmentText: 'when are fees due?' }), 'privacy');
  assert.equal(classifyFriendInput({ text: '   ', attachmentText: 'my classmate’s email address' }), 'privacy');
});

test('an academic request hidden in the image half routes to the Guide', () => {
  assert.equal(classifyFriendInput({ text: 'what about this?', attachmentText: 'formula sheet' }), 'academic');
  assert.equal(classifyFriendInput({ text: 'derive the wave equation', attachmentText: '' }), 'academic');
});

test('an ordinary ops turn stays ops with an ordinary image attached', () => {
  assert.equal(classifyFriendInput({ text: 'when are fees due?', attachmentText: 'receipt june' }), 'ops');
  assert.equal(classifyFriendInput({ text: '' }), 'ops');
});

test('text derived from an attachment is read without touching the bytes', () => {
  const attachments: ChatAttachment[] = [
    { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==', name: 'notice.png', altText: 'week 6' },
    { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==', name: 'receipt.png' },
  ];
  assert.equal(declaredAttachmentText(attachments), 'notice.png week 6\nreceipt.png');
  assert.equal(declaredAttachmentText(), '');
  assert.equal(declaredAttachmentText([{ kind: 'image', mimeType: 'image/png', data: 'x' }]), '');
});

test('a filename cannot carry a privacy request past the check', () => {
  const text = declaredAttachmentText([{ kind: 'image', mimeType: 'image/png', data: 'x', name: "my friend's whatsapp number.png" }]);
  assert.equal(classifyFriendInput({ text: 'look at this', attachmentText: text }), 'privacy');
});

test('model text describing an image is classified the same way as typed text', () => {
  assert.equal(extractedTextLane('I can see my roommate’s phone number on the notice.'), 'privacy');
  assert.equal(extractedTextLane('This photo shows the fee receipt for week 6.'), 'ops');
});