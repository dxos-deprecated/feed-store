//
// Copyright 2019 DXOS.org
//

import assert from 'assert';
import multi from 'multi-read-stream';
import pump from 'pump';
import through from 'through2';
import from2 from 'from2';
import eos from 'end-of-stream';
import ram from 'random-access-memory';
import pify from 'pify';

import createBatchStream from './create-batch-stream';
import { FeedStore } from './feed-store';
import FeedDescriptor from './feed-descriptor';
import OrderedReader from './ordered-reader';
import waitForExpect from 'wait-for-expect';

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

test('OrderedReader', async () => {
  const feedStore = await FeedStore.create(ram, { feedOptions: { valueEncoding: 'utf-8' } });

  const MESSAGE_COUNT = 10;

  const [feed1, feed2] = await generateStreamData(feedStore, MESSAGE_COUNT);

  const messages = [];

  const allowedFeeds = new Set(['/feed1'])
  const stream = feedStore.createOrderedStream(
    async (feedDescriptor, message) => allowedFeeds.has(feedDescriptor.path)
  );

  stream.on('data', message => {
    messages.push(message);
    if(message.data.startsWith('allow-')) {
      allowedFeeds.add(message.data.slice(6));
    }
  })


  // only feed1 messages should be here at this point
  await waitForExpect(async () => {
    expect(messages.length === MESSAGE_COUNT);
    expect(messages.every(msg => msg.data.startsWith('feed1')))
  })

  await append(feed1, 'allow-/feed2')

  await waitForExpect(() => expect(messages.length).toBe(MESSAGE_COUNT * 2 + 1))

  // TODO(marik-d): Test for sync events
});
