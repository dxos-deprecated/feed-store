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

  const onSync = jest.fn();
  const messages = [];

  const feedCounters = {}
  const stream = feedStore.createOrderedStream(
    async (feedDescriptor, message) => {
      if (message.data.startsWith('feed2')) {
        return true;
      } else {
        return feedCounters['feed2'] >= MESSAGE_COUNT;
      }
    }
  );

  stream.on('data', message => {
    feedCounters[message.data.slice(0, 5)] = (feedCounters[message.data.slice(0, 5)] ?? 0) + 1
    messages.push(message);
  })

  stream.on('sync', onSync);

  await waitForExpect(() => expect(messages.length).toBe(MESSAGE_COUNT * 2))
  


  // order test
  messages.slice(0, MESSAGE_COUNT).forEach(msg => {
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