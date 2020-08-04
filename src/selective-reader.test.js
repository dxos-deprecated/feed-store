//
// Copyright 2019 DXOS.org
//

import pify from 'pify';
import ram from 'random-access-memory';
import waitForExpect from 'wait-for-expect';
import { FeedStore } from './feed-store';

function append (feed, message) {
  return pify(feed.append.bind(feed))(message);
}

async function generateStreamData (feedStore, maxMessages = 200) {
  const [feed1, feed2] = await Promise.all([
    feedStore.openFeed('/feed1'),
    feedStore.openFeed('/feed2')
  ]);

  const messages = [];
  for (let i = 0; i < maxMessages; i++) {
    messages.push(append(feed1, `feed1/message${i}`));
    messages.push(append(feed2, `feed2/message${i}`));
  }

  await Promise.all(messages);

  return [feed1, feed2];
}

describe('SelectiveReader', () => {
  test('two feeds', async () => {
    const feedStore = await FeedStore.create(ram, { feedOptions: { valueEncoding: 'utf-8' } });

    const MESSAGE_COUNT = 10;

    const [feed1] = await generateStreamData(feedStore, MESSAGE_COUNT);

    const messages = [];

    const allowedFeeds = new Set(['/feed1']);
    const stream = feedStore.createSelectiveStream(
      async (feedDescriptor, message) => allowedFeeds.has(feedDescriptor.path)
    );

    setTimeout(async () => {
      for await(const message of stream) {
        console.log(message)
        messages.push(message);
        if (message.data.startsWith('allow-')) {
          allowedFeeds.add(message.data.slice(6));
        }
        if(messages.length === MESSAGE_COUNT * 2 + 1) {
          break;
        }
      }
    })
    console.log('asserting')

    // only feed1 messages should be here at this point
    await waitForExpect(async () => {
      console.log('TEST')
      expect(messages.length === MESSAGE_COUNT);
      expect(messages.every(msg => msg.data.startsWith('feed1')));
    });

    console.log('ALLOW feed 2')
    await append(feed1, 'allow-/feed2');

    await waitForExpect(() => expect(messages.length).toBe(MESSAGE_COUNT * 2 + 1));

    // TODO(marik-d): Test for sync events
  });

  test('feed is added later', async () => {
    const feedStore = await FeedStore.create(ram, { feedOptions: { valueEncoding: 'utf-8' } });

    const MESSAGE_COUNT = 10;

    await generateStreamData(feedStore, MESSAGE_COUNT);

    const messages = [];

    const allowedFeeds = new Set(['/feed1', '/feed3']);
    const stream = feedStore.createSelectiveStream(
      async (feedDescriptor, message) => allowedFeeds.has(feedDescriptor.path)
    );

    stream.on('data', message => {
      messages.push(message);
      if (message.data.startsWith('allow-')) {
        allowedFeeds.add(message.data.slice(6));
      }
    });

    // only feed1 messages should be here at this point
    await waitForExpect(async () => {
      expect(messages.length === MESSAGE_COUNT);
      expect(messages.every(msg => msg.data.startsWith('feed1')));
    });

    const feed = await feedStore.openFeed('/feed3');
    await append(feed, 'allow-/feed2');

    await waitForExpect(() => expect(messages.length).toBe(MESSAGE_COUNT * 2 + 1));

    // TODO(marik-d): Test for sync events
  });

  it('large feed thats never read', async () => {
    const feedStore = await FeedStore.create(ram, { feedOptions: { valueEncoding: 'utf-8' } });
    const readingFeed = await feedStore.openFeed('/feed1');
    const ignoredFeed = await feedStore.openFeed('/feed2');
    for (let i = 0; i < 10_000; i++) {
      await append(ignoredFeed, `msg-${i}`);
    }
    await append(readingFeed, 'message');

    const stream = feedStore.createSelectiveStream(
      async (feedDescriptor, message) => feedDescriptor.path === '/feed1'
    );
    const messages = [];
    stream.on('data', message => {
      messages.push(message);
    });
    await waitForExpect(async () => {
      expect(messages.length === 1);
      expect(messages[0].data).toEqual('message');
    });
  });
});
