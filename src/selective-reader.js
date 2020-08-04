//
// Copyright 2019 DXOS.org
//

import { Readable } from 'stream';
import createBatchStream from './create-batch-stream';
import FeedDescriptor from './feed-descriptor';
import { assert } from 'console';
import { rejects } from 'assert';

/**
 * Creates a multi ReadableStream for feed streams.
 */
export default class SelectiveReader {
  /** @type {(feedDescriptor, message) => Promise<boolean>} */
  _evaluator;

  /** @type {Readable} */
  _stream;

  _sink = new CombinedAsyncIterator();

  constructor (evaluator) {
    this._evaluator = evaluator;

    // this._stream = Readable.from(this._generateData(), { objectMode: true })
  }

  // get stream() { return this._stream; }

  async *_generateData() {
    for await (const msg of this._sink) {
      if(msg !== null) {
        yield msg
      }
    }
  }

  /**
   * @param {FeedDescriptor} descriptor
   * @param {Readable} stream 
   */
  async *_generateFeedData(descriptor, stream) {
    for await (const batch of stream) {
      for (const message of batch) {
        while(!await this._evaluator(descriptor, message)) {
          yield null;
        }
        yield message;  
      }
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
    const stream = new Readable({ objectMode: true }).wrap(createBatchStream(descriptor.feed, { live: true }));

    this._sink.add(this._generateFeedData(descriptor, stream));
  }
}

/**
 * @implements {AsyncIterableIterator}
 */
class CombinedAsyncIterator {

  /** @type {{ iterator: AsyncIterator, running: boolean, frozen: boolean }[]} */
  _iterators = [];

  _queue = [];

  /** @type {{resolve: () => void, reject: (err: any) => void } | undefined} */
  _pollResolve;

  _error;

  [Symbol.asyncIterator]() {
    return this
  }

  /**
   * @returns {Promise<{ done: false, value: any }>}
   */
  async next() {
    console.log('CombinedAsyncIterator.next', this._queue.length)
    if(this._error) {
      throw this._error;
    }

    if (this._queue.length > 0) {
      return { done: false, value: this._queue.shift() };
    }

    return new Promise((resolve, reject) => {
      this._pollResolve = { 
        resolve: () => {
          this._pollResolve = undefined;
          console.log('CombinedAsyncIterator.next unfreeze descritors')
          for(const descriptor of this._iterators) {
            descriptor.frozen = false;
          }

          assert(this._queue.length > 0)
          resolve({ done: false, value: this._queue.shift() });
        },
        reject,
      }

      for(const iteratorDescriptor of [...this._iterators]) {
        this._pollIterator(iteratorDescriptor);
      }
    })
  }

  _pollIterator(descriptor) {
    if (descriptor.running || descriptor.frozen) {
      return
    }
    descriptor.running = true;
    descriptor.iterator.next()
      .then(result => {
        if(result.done) {
          console.log('CombinedAsyncIterator._pollIterator remove descriptor')
          this._iterators = this._iterators.filter(x => x !== descriptor);
        } else if(result.value === null) {
          console.log('CombinedAsyncIterator._pollIterator freeze descriptor')
          descriptor.running = false;
          descriptor.frozen = true;
        } else {
          console.log('CombinedAsyncIterator._pollIterator push from descriptor')
          descriptor.running = false;
          this._queue.push(result.value);
          this._pollResolve?.resolve();
        }
      }, err => this._onError(err))
  }

  _onError(error) {
    if(this._pollResolve) {
      this._pollResolve.reject(error)
    } else {
      this._error = error;
    }
  }

  /**
   * 
   * @param {AsyncIterator} iterator 
   */
  add(iterator) {
    const descriptor = { iterator, running: false, frozen: false };
    this._iterators.push(descriptor);
    if(this._pollResolve) {
      this._pollIterator(descriptor);
    }
  }
}