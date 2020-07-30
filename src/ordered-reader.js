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