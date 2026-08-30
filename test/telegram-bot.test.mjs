import test from 'node:test';
import assert from 'node:assert/strict';

import { configureTelegram, notifyReady } from '../bin/telegram-bot.mjs';

const BASE_CONFIG = {
  botToken: 'test-token',
  chatId: '-100123',
  boardUrl: 'https://board.example',
  apiToken: 'board-token',
  founders: [
    { name: 'Anton', tgUserId: 1001, tag: '@anton', owner: true },
  ],
};

const CARD = {
  id: 'sprint-one',
  title: 'Payments sprint',
  links: { ticket: 'https://github.com/acme/web/issues/1515' },
};

test('notifyReady sends one exact line to ownerChatId, falling back to chatId', async () => {
  const originalFetch = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, result: { message_id: payloads.length } }; },
    };
  };

  try {
    configureTelegram({ ...BASE_CONFIG, ownerChatId: '4242' });
    await notifyReady(CARD);

    configureTelegram(BASE_CONFIG);
    await notifyReady(CARD);
  } finally {
    configureTelegram(null);
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(payloads.map(payload => payload.chat_id), ['4242', '-100123']);
  assert.deepEqual(payloads.map(payload => payload.text), [
    'Sprint Payments sprint is ready for acceptance — https://github.com/acme/web/issues/1515',
    'Sprint Payments sprint is ready for acceptance — https://github.com/acme/web/issues/1515',
  ]);
  assert.ok(payloads.every(payload => !payload.text.includes('board.example')),
    'the owner receives the umbrella link, not a board link');
});
