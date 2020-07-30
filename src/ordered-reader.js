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
import { Readable } from 'stream'

import createBatchStream from './create-batch-stream';
import { FeedStore } from './feed-store';
import FeedDescriptor from './feed-descriptor';

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
    super({ objectMode: true })

    this._evaluator = evaluator;

    this._hasData = new Promise(resolve => { this._wakeUpReader = resolve; });
  }

  async _read() {
    if(this._reading) {
      this._needsData = true;
      return;
    }
    this._reading = true;
    this._needsData = false;

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
            process.nextTick(() => this._wakeUpReader());
            this._needsData = false;
            if(!this.push(message)) {
              console.log('read ended')
              this._reading = false;
              return;
            }
          } else {
            console.log('unshift', feed.descriptor.path)
            feed.buffer.unshift(message)
            break;
          }
        }
      }

      if(this._needsData && Array.from(this._feeds.values()).some(x => x.buffer.length > 0)) {
        continue;
      }
      await this._hasData;
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
      console.log('feed readable', descriptor.path);

      this._wakeUpReader();
    });

    this._feeds.add({ descriptor, stream, buffer: [] });
  }
}