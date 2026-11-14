import test from 'node:test';
import assert from 'node:assert/strict';
import { isManualReplyRoleName, manualReplyRoleNames } from '../toolkit/phone/messages/manual-reply-role-names.js';

const contact = { id: 'tavern_蔚轶30', name: '蔚轶', remark: '老公' };

test('accepts the display name, remark, contact id and original tavern name', () => {
  assert.deepEqual(
    manualReplyRoleNames(contact).sort(),
    ['tavern_蔚轶30', '蔚轶', '蔚轶30', '老公'].sort(),
  );
  for (const name of ['蔚轶', '老公', '蔚轶30', 'tavern_蔚轶30']) {
    assert.equal(isManualReplyRoleName(contact, name), true, name);
  }
});

test('compares ASCII names case-insensitively and trims whitespace', () => {
  assert.equal(isManualReplyRoleName({ id: 'tavern_Assistant', name: 'Assistant' }, ' assistant '), true);
  assert.equal(isManualReplyRoleName({ id: 'tavern_Assistant', name: 'Assistant' }, 'ASSISTANT'), true);
});

test('rejects another character and empty names', () => {
  assert.equal(isManualReplyRoleName(contact, '小千'), false);
  assert.equal(isManualReplyRoleName(contact, '小宴'), false);
  assert.equal(isManualReplyRoleName(contact, '   '), false);
  assert.equal(isManualReplyRoleName(contact, null), false);
});
