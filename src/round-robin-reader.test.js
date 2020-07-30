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

const { Readable } = require('stream');

/**
 * Creates a multi ReadableStream for feed streams.
 */
export default class OrderedReader {
  /** @type {(feedDescriptor, message) => Promise<boolean>} */
  _evaluator;

  /** @type {any} */
  _stream;

  /** @type {Set<{ descriptor: FeedDescriptor, stream: any, buffer: any[] }>} */
  _feeds = new Set();

  /** @type {() => void} */
  _wakeUpReader;

  /** @type {Promise} */
  _hasData;

  constructor (evaluator) {
    this._evaluator = evaluator;

    this._hasData = new Promise(resolve => { this._wakeUpReader = resolve; });

    this._stream = new Readable({ 
      objectMode: true,
      read: async () => {
        console.log('_read called')

        while(true) {
          this._hasData = new Promise(resolve => { this._wakeUpReader = resolve; });

          console.log('starting read cycle')
          for (const feed of this._feeds.values()) {
            if(feed.buffer.length === 0) {
              const messages = feed.stream.read();
              console.log('reading from feed', feed.descriptor.path, messages, feed.stream._readableState.flowing, feed.stream.readable);
              if(!messages) continue;
              feed.buffer.push(...messages)
            }

            console.log('processing', feed.descriptor.path)
            let message;
            while(message = feed.buffer.shift()) {
              if (await this._evaluator(feed.descriptor, message)) {
                console.log('approved')
                if(!this._stream.push(message)) {
                  console.log('read ended')
                  return;
                }
              } else {
                console.log('unshift', feed.descriptor.path)
                feed.buffer.unshift(message)
                break;
              }
            }
          }

          await this._hasData;
        }
      },
    });
  }

  get stream () { return this._stream; }

  async addInitialFeedStreams (descriptors) {
    for (const descriptor of descriptors) {
      this.addFeedStream(descriptor);
    }
  }

  /**
   * Adds a feed stream and stream the block data, seq, key and metadata.
   *
   * @param {FeedDescriptor} descriptor
   */
  async addFeedStream (descriptor) {
    const stream = createBatchStream(descriptor.feed, { live: true });

    stream.on('readable', () => {
      console.log('feed readable', descriptor.path);

      this._wakeUpReader();
    });

    this._feeds.add({ descriptor, stream, buffer: [] });
  }
}

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

  const [feed1, feed2] = await generateStreamData(feedStore, 1);

  const onSync = jest.fn();
  const messages = [];

  let feed2Msgs = 0;
  const stream = feedStore.createOrderedStream(
    async (feedDescriptor, message) => {
      if (message.data.startsWith('feed2')) {
        return true;
      } else {
        return feed2Msgs > 0;
      }
    }
  );

  for await (const message of stream) {
    if (message.data.startsWith('feed2')) {
      feed2Msgs++;
    }
    console.log('got', message)
    messages.push(message);
  }

  stream.on('sync', onSync);
  await new Promise(resolve => eos(stream, () => resolve()));

  expect(messages.length).toBe(2);

  console.log(messages);

  // order test
  messages.slice(0, 10).forEach(msg => {
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
