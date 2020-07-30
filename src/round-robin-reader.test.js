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

class Counter extends Readable {
  constructor (opt) {
    super(opt);
    this._max = 1000000;
    this._index = 1;
  }

  _read () {
    const i = this._index++;
    if (i > this._max) { this.push(null); } else {
      const str = String(i);
      const buf = Buffer.from(str, 'ascii');
      this.push(buf);
    }
  }
}

/**
 * Creates a multi ReadableStream for feed streams.
 */
export default class OrderedReader {
  /** @type {(feedDescriptor, message) => Promise<boolean>} */
  _evaluator;

  /** @type {any} */
  _stream;

  /** @type {Set<{ descriptor: FeedDescriptor, stream: any, message?: object }>} */
  _feeds = new Set();

  /** @type {() => void | undefined} */
  _wakeUpReader;

  _hasData;

  constructor (evaluator) {
    this._evaluator = evaluator;

    this._hasData = new Promise(resolve => {
      this._wakeUpReader = () => {
        this._wakeUpReader = null;
        resolve();
      };
    });

    this._stream = from2.obj(async (size, next) => {
      const tryReading = async () => {
        const toPush = [];

        this._hasData = new Promise(resolve => {
          this._wakeUpReader = () => {
            this._wakeUpReader = null;
            resolve();
          };
        });

        for (const feed of this._feeds.values()) {
          if (toPush.length >= size) break;

          const msg = feed.stream.read();
          console.log('reading from feed', feed.descriptor.path, msg, feed.stream._readableState.flowing, feed.stream.readable);
          if (!msg) continue;
          if (await this._evaluator(feed.descriptor, msg)) {
            toPush.push(msg);
          } else {
            feed.message = msg;
          }
        }

        if (toPush.length > 0) {
          next(null, toPush);
          return true;
        } else {
          return false;
        }
      };

      while (!await tryReading()) {
        await this._hasData;
      }
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

      this._wakeUpReader?.();
    });

    this._feeds.add({ descriptor, stream });
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
  stream.on('readable', () => {
    let message;
    while (message = stream.read()) {
      if (message.data.startsWith('feed2')) {
        feed2Msgs++;
      }
      messages.push(message);
    }
  });

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
