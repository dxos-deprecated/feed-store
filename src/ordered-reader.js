//
// Copyright 2019 DXOS.org
//

import { Readable } from 'stream';
import createBatchStream from './create-batch-stream';

/**
 * Creates a multi ReadableStream for feed streams.
 */
export default class OrderedReader extends Readable {
  /** @type {(feedDescriptor, message) => Promise<boolean>} */
  _evaluator;

  /** @type {Set<{ descriptor: FeedDescriptor, stream: any, buffer: any[] }>} */
  _feeds = new Set();

  /** @type {() => void} */
  _wakeUpReader;

  /** @type {Promise} */
  _hasData;

  _reading = false;

  constructor (evaluator) {
    super({ objectMode: true });

    this._evaluator = evaluator;

    this._hasData = new Promise(resolve => { this._wakeUpReader = resolve; });
  }

  async _read () {
    if (this._reading) {
      this._needsData = true;
      return;
    }
    this._reading = true;
    this._needsData = false;

    this._pollFeeds();
  }

  async _pollFeeds () {
    this._hasData = new Promise(resolve => { this._wakeUpReader = resolve; });

    for (const feed of this._feeds.values()) {
      if (feed.buffer.length === 0) {
        const messages = feed.stream.read();
        // console.log('reading from feed', feed.descriptor.path, messages, feed.stream._readableState.flowing, feed.stream.readable);
        if (!messages) continue;
        feed.buffer.push(...messages);
      }

      // console.log('processing', feed.descriptor.path)
      let message;
      while ((message = feed.buffer.shift())) {
        if (await this._evaluator(feed.descriptor, message)) {
          // console.log('approved')
          process.nextTick(() => this._wakeUpReader());
          this._needsData = false;
          if (!this.push(message)) {
            // console.log('read ended')
            this._reading = false;
            return;
          }
        } else {
          // console.log('unshift', feed.descriptor.path)
          feed.buffer.unshift(message);
          break;
        }
      }
    }

    if (this._needsData && Array.from(this._feeds.values()).some(x => x.buffer.length > 0)) {
      setTimeout(() => this._pollFeeds(), 0);
    } else {
      await this._hasData;
      setTimeout(() => this._pollFeeds(), 0);
    }
  }

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
      // console.log('feed readable', descriptor.path);

      this._wakeUpReader();
    });

    this._feeds.add({ descriptor, stream, buffer: [] });
  }
}
