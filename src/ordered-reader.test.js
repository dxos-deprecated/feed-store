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
  console.log("TEST STARTED")

  const feedStore = await FeedStore.create(ram, { feedOptions: { valueEncoding: 'utf-8' } });

  const [feed1, feed2] = await generateStreamData(feedStore, 1);

  const onSync = jest.fn();
  const messages = [];

  const feedCounters = {}
  const stream = feedStore.createOrderedStream(
    async (feedDescriptor, message) => {
      console.log('evaluate', { message, feedCounters })
      if (message.data.startsWith('feed2')) {
        return true;
      } else {
        return feedCounters['feed2'] > 0;
      }
    }
  );

  for await (const message of stream) {
    feedCounters[message.data.slice(0, 5)] = (feedCounters[message.data.slice(0, 5)] ?? 0) + 1
    console.log('got', { message, feedCounters })
    messages.push(message);
    if(Object.values(feedCounters).length === 2 && Object.values(feedCounters).every(x => x == 1)) {
      console.log('END')
      break;
    }
  }

  stream.on('sync', onSync);

  expect(messages.length).toBe(2);

  console.log(messages);

  // order test
  messages.slice(0, 1).forEach(msg => {
    expect(msg.data.startsWith('feed2')).toBe(true);
  });

  // sync test
  // const syncMessages = messages.filter(m => m.sync);
  // expect(syncMessages.length).toBe(1);
  // expect(syncMessages[0].key).toEqual(feed1.key);
  // expect(onSync).toHaveBeenCalledTimes(1);
  // expect(onSync).toHaveBeenCalledWith({
  //   [feed1.key.toString('hex')]: 19
  // });
});
