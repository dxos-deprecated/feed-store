//
// Copyright 2019 DxOS.
//

import hypertrie from 'hypertrie';
import tempy from 'tempy';
import ram from 'random-access-memory';
import hypercore from 'hypercore';
import pify from 'pify';
import wait from 'wait-for-expect';
import eos from 'end-of-stream-promise';

import { FeedStore } from './feed-store';

async function createDefault () {
  const directory = tempy.directory();

  return {
    directory,
    feedStore: await FeedStore.create(directory, { feedOptions: { valueEncoding: 'utf-8' } })
  };
}

async function defaultFeeds (feedStore) {
  return {
    booksFeed: await feedStore.openFeed('/books', { metadata: { topic: 'books' } }),
    usersFeed: await feedStore.openFeed('/users'),
    groupsFeed: await feedStore.openFeed('/groups')
  };
}

describe('FeedStore', () => {
  test('Config default', async () => {
    const feedStore = await FeedStore.create(ram);
    expect(feedStore).toBeInstanceOf(FeedStore);
    expect(feedStore.opened).toBeTruthy();
    expect(feedStore.storage).toBe(ram);
    await expect(feedStore.ready()).resolves.toBeUndefined();

    const feedStore2 = new FeedStore(ram);
    expect(feedStore2).toBeInstanceOf(FeedStore);
    expect(feedStore2.opened).toBeFalsy();
    feedStore2.open();
    await expect(feedStore2.ready()).resolves.toBeUndefined();
    expect(feedStore2.opened).toBeTruthy();
  });

  test('Config default + custom database + custom hypercore', async () => {
    const customHypercore = jest.fn((...args) => {
      return hypercore(...args);
    });

    const database = hypertrie(ram, { valueEncoding: 'json' });
    database.list = jest.fn((_, cb) => cb(null, []));

    const feedStore = await FeedStore.create(ram, {
      database: () => database,
      hypercore: customHypercore
    });

    expect(feedStore).toBeInstanceOf(FeedStore);
    expect(database.list.mock.calls.length).toBe(1);

    await feedStore.openFeed('/test');

    expect(customHypercore.mock.calls.length).toBe(1);
  });

  test('Should throw an assert error creating without storage.', async () => {
    await expect(FeedStore.create()).rejects.toThrow(/storage is required/);
  });

  test('Create feed', async () => {
    const { feedStore } = await createDefault();
    const { booksFeed } = await defaultFeeds(feedStore);

    expect(booksFeed).toBeInstanceOf(hypercore);

    const booksFeedDescriptor = feedStore.getDescriptors().find(fd => fd.path === '/books');
    expect(booksFeedDescriptor).toHaveProperty('path', '/books');
    expect(booksFeedDescriptor.metadata).toHaveProperty('topic', 'books');

    await pify(booksFeed.append.bind(booksFeed))('Foundation and Empire');
    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');

    // It should return the same opened instance.
    await expect(feedStore.openFeed('/books')).resolves.toBe(booksFeed);

    // You can't open a feed with a different key.
    await expect(feedStore.openFeed('/books', { key: Buffer.from('...') })).rejects.toThrow(/Invalid public key/);
    await expect(feedStore.openFeed('/foo', { key: booksFeed.key })).rejects.toThrow(/Feed exists/);
  });

  test('Create duplicate feed', async () => {
    const { feedStore } = await createDefault();

    const [usersFeed, feed2] = await Promise.all([feedStore.openFeed('/users'), feedStore.openFeed('/users')]);
    expect(usersFeed).toBe(feed2);

    await pify(usersFeed.append.bind(usersFeed))('alice');
    await expect(pify(usersFeed.head.bind(usersFeed))()).resolves.toBe('alice');
  });

  test('Create and close a feed', async () => {
    const { feedStore } = await createDefault();

    await expect(feedStore.closeFeed('/foo')).rejects.toThrow(/Feed not found/);

    const foo = await feedStore.openFeed('/foo');
    expect(foo.opened).toBeTruthy();
    expect(foo.closed).toBeFalsy();

    await feedStore.closeFeed('/foo');
    expect(foo.closed).toBeTruthy();
  });

  test('Descriptors', async () => {
    const { feedStore } = await createDefault();
    const { booksFeed } = await defaultFeeds(feedStore);

    expect(feedStore.getDescriptors().map(fd => fd.path)).toEqual(['/books', '/users', '/groups']);
    expect(feedStore.getDescriptorByDiscoveryKey(booksFeed.discoveryKey).path).toEqual('/books');
  });

  test('Feeds', async () => {
    const { feedStore } = await createDefault();
    const { booksFeed, usersFeed, groupsFeed } = await defaultFeeds(feedStore);

    expect(feedStore.getOpenFeeds().map(f => f.key)).toEqual([booksFeed.key, usersFeed.key, groupsFeed.key]);
    expect(feedStore.getOpenFeed(fd => fd.key.equals(booksFeed.key))).toBe(booksFeed);
    expect(feedStore.getOpenFeed(() => false)).toBeUndefined();
    expect(feedStore.getOpenFeeds(fd => fd.path === '/books')).toEqual([booksFeed]);
  });

  test('Close/Load feed', async () => {
    const { feedStore } = await createDefault();
    const { booksFeed } = await defaultFeeds(feedStore);

    await feedStore.closeFeed('/books');
    expect(feedStore.getDescriptors().find(fd => fd.path === '/books')).toHaveProperty('opened', false);

    const [feed] = await feedStore.openFeeds(fd => fd.path === '/books');
    expect(feed).toBeDefined();
    expect(feed.key).toEqual(booksFeed.key);
    expect(feedStore.getDescriptors().find(fd => fd.path === '/books')).toHaveProperty('opened', true);
  });

  test('Close feedStore and their feeds', async () => {
    const { feedStore } = await createDefault();
    await defaultFeeds(feedStore);

    expect(feedStore.opened).toBe(true);
    expect(feedStore.closed).toBe(false);
    expect(feedStore.getDescriptors().filter(fd => fd.opened).length).toBe(3);

    await feedStore.close();
    expect(feedStore.getDescriptors().filter(fd => fd.opened).length).toBe(0);
    expect(feedStore.opened).toBe(false);
    expect(feedStore.closed).toBe(true);
  });

  test('Reopen feedStore and recreate feeds from the indexDB', async () => {
    const { feedStore } = await createDefault();
    let { booksFeed, usersFeed } = await defaultFeeds(feedStore);

    await pify(booksFeed.append.bind(booksFeed))('Foundation and Empire');
    await pify(usersFeed.append.bind(usersFeed))('alice');

    await feedStore.close();
    await feedStore.open();
    expect(feedStore.opened).toBe(true);
    expect(feedStore.getDescriptors().length).toBe(3);

    booksFeed = await feedStore.openFeed('/books');
    ([usersFeed] = await feedStore.openFeeds(fd => fd.path === '/users'));
    expect(feedStore.getDescriptors().filter(fd => fd.opened).length).toBe(2);

    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');
    await expect(pify(usersFeed.head.bind(usersFeed))()).resolves.toBe('alice');

    // The metadata of /books should be recreate too.
    const metadata = { topic: 'books' };
    expect(feedStore.getDescriptors().find(fd => fd.path === '/books').metadata).toEqual(metadata);
  });

  test('Delete descriptor', async () => {
    const { feedStore } = await createDefault();
    await defaultFeeds(feedStore);

    await feedStore.deleteDescriptor('/books');
    expect(feedStore.getDescriptors().length).toBe(2);
  });

  test('Default codec: binary', async () => {
    const feedStore = await FeedStore.create(ram);
    expect(feedStore).toBeInstanceOf(FeedStore);

    const feed = await feedStore.openFeed('/test');
    expect(feed).toBeInstanceOf(hypercore);
    await pify(feed.append.bind(feed))('test');
    await expect(pify(feed.head.bind(feed))()).resolves.toBeInstanceOf(Buffer);
  });

  test('Default codec: json + custom codecs', async () => {
    const options = {
      feedOptions: { valueEncoding: 'utf-8' },
      codecs: {
        codecA: {
          encode (val) {
            val.encodedBy = 'codecA';
            return Buffer.from(JSON.stringify(val));
          },
          decode (val) {
            return JSON.parse(val);
          }
        },
        codecB: {
          name: 'codecB',
          encode (val) {
            val.encodedBy = 'codecB';
            return Buffer.from(JSON.stringify(val));
          },
          decode (val) {
            return JSON.parse(val);
          }
        }
      }
    };
    const feedStore = await FeedStore.create(ram, options);
    expect(feedStore).toBeInstanceOf(FeedStore);

    {
      const feed = await feedStore.openFeed('/test');
      expect(feed).toBeInstanceOf(hypercore);
      await pify(feed.append.bind(feed))('test');
      await expect(pify(feed.head.bind(feed))()).resolves.toBe('test');
    }
    {
      const feed = await feedStore.openFeed('/a', { valueEncoding: 'codecA' });
      expect(feed).toBeInstanceOf(hypercore);
      await pify(feed.append.bind(feed))({ msg: 'test' });
      await expect(pify(feed.head.bind(feed))()).resolves.toEqual({ msg: 'test', encodedBy: 'codecA' });
    }
  });

  test('on open error should unlock the descriptor', async () => {
    const feedStore = await FeedStore.create(ram, {
      hypercore: () => {
        throw new Error('open error');
      }
    });

    await expect(feedStore.openFeed('/foo')).rejects.toThrow(/open error/);

    const fd = feedStore.getDescriptors().find(fd => fd.path === '/foo');
    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('on close error should unlock the descriptor', async () => {
    const feedStore = await FeedStore.create(ram, {
      hypercore: () => ({
        opened: true,
        ready (cb) { cb(); },
        on () {},
        close () {
          throw new Error('close error');
        }
      })
    });

    await feedStore.openFeed('/foo');
    const fd = feedStore.getDescriptors().find(fd => fd.path === '/foo');

    await expect(feedStore.closeFeed('/foo')).rejects.toThrow(/close error/);
    await expect(feedStore.close()).rejects.toThrow(/close error/);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('on delete descriptor error should unlock the descriptor', async () => {
    const feedStore = await FeedStore.create(ram);

    await feedStore.openFeed('/foo');
    const fd = feedStore.getDescriptors().find(fd => fd.path === '/foo');

    // We remove the indexDB to force an error.
    feedStore._indexDB = null;

    await expect(feedStore.deleteDescriptor('/foo')).rejects.toThrow(Error);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('createReadStream', async () => {
    const feedStore = await FeedStore.create(ram);

    const synced = jest.fn();

    const foo = await feedStore.openFeed('/foo');
    const bar = await feedStore.openFeed('/bar');
    await Promise.all([
      pify(foo.append.bind(foo))('foo1'),
      pify(bar.append.bind(bar))('bar1')
    ]);

    const stream = feedStore.createReadStream();
    stream.on('synced', synced);

    const messages = [];
    stream.on('data', (chunk) => {
      messages.push(chunk.toString('utf8'));
    });

    const liveStream1 = testLiveStream({ live: true });
    const liveStream2 = testLiveStream(() => ({ live: true }));

    await eos(stream);
    expect(messages.sort()).toEqual(['bar1', 'foo1']);

    const quz = await feedStore.openFeed('/quz');
    await pify(quz.append.bind(quz))('quz1');

    await Promise.all([liveStream1, liveStream2]);

    expect(synced).toBeCalledTimes(3);

    async function testLiveStream (...args) {
      const liveMessages = [];
      const liveStream = feedStore.createReadStream(...args);
      liveStream.on('synced', synced);

      liveStream.on('data', (chunk) => {
        liveMessages.push(chunk.toString('utf8'));
      });
      await wait(() => {
        expect(liveMessages.sort()).toEqual(['bar1', 'foo1', 'quz1']);
      });
      liveStream.destroy();
    }
  });

  test('createReadStreamByFilter', async () => {
    const synced = jest.fn();

    const feedStore = await FeedStore.create(ram);

    const foo = await feedStore.openFeed('/foo', { metadata: { topic: 'topic1' } });
    const bar = await feedStore.openFeed('/bar');

    await Promise.all([
      pify(foo.append.bind(foo))('foo1'),
      pify(bar.append.bind(bar))('bar1')
    ]);

    const stream = feedStore.createReadStream(({ metadata = {} }) => {
      if (metadata.topic === 'topic1') {
        return true;
      }
    });
    stream.on('synced', synced);

    const liveStream = testLiveStream(({ metadata = {} }) => {
      if (metadata.topic === 'topic1') {
        return { live: true };
      }
    });

    const messages = [];
    stream.on('data', (chunk) => {
      messages.push(chunk.toString('utf8'));
    });

    await eos(stream);
    expect(messages.sort()).toEqual(['foo1']);

    const baz = await feedStore.openFeed('/baz');
    await pify(baz.append.bind(baz))('baz1');

    const quz = await feedStore.openFeed('/quz', { metadata: { topic: 'topic1' } });
    await pify(quz.append.bind(quz))('quz1');

    await liveStream;

    expect(synced).toBeCalledTimes(2);

    async function testLiveStream (...args) {
      const liveMessages = [];
      const liveStream = feedStore.createReadStream(...args);
      liveStream.on('synced', synced);
      liveStream.on('data', (chunk) => {
        liveMessages.push(chunk.toString('utf8'));
      });

      await wait(() => {
        expect(liveMessages.sort()).toEqual(['foo1', 'quz1']);
      });
      liveStream.destroy();
    }
  });

  test('createReadStream with feedStoreInfo', async () => {
    const sort = (a, b) => {
      if (a.data > b.data) return 1;
      if (a.data < b.data) return -1;
      return 0;
    };

    const feedStore = await FeedStore.create(ram, { feedOptions: { valueEncoding: 'utf-8' } });

    const foo = await feedStore.openFeed('/foo');
    const bar = await feedStore.openFeed('/bar');
    await Promise.all([
      pify(foo.append.bind(foo))('foo1'),
      pify(foo.append.bind(foo))('foo2'),
      pify(bar.append.bind(bar))('bar1'),
      pify(bar.append.bind(bar))('bar2')
    ]);

    const stream = feedStore.createReadStream(descriptor => {
      const options = { feedStoreInfo: true };
      if (descriptor.path === '/foo') {
        options.start = 1;
      }

      return options;
    });

    const messages = [];
    stream.on('data', (chunk) => {
      messages.push(chunk);
    });

    const liveStream1 = testLiveStream({ live: true, feedStoreInfo: true });

    await eos(stream);

    expect(messages.sort(sort)).toEqual([
      { data: 'bar1', seq: 0, path: '/bar', key: bar.key, metadata: undefined },
      { data: 'bar2', seq: 1, path: '/bar', key: bar.key, metadata: undefined },
      { data: 'foo2', seq: 1, path: '/foo', key: foo.key, metadata: undefined }
    ]);

    const quz = await feedStore.openFeed('/quz');
    await pify(quz.append.bind(quz))('quz1');

    await liveStream1;

    async function testLiveStream (...args) {
      const liveMessages = [];
      const liveStream = feedStore.createReadStream(...args);
      liveStream.on('data', (chunk) => {
        liveMessages.push(chunk);
      });
      await wait(() => {
        expect(liveMessages.sort(sort)).toEqual([
          { data: 'bar1', seq: 0, path: '/bar', key: bar.key, metadata: undefined },
          { data: 'bar2', seq: 1, path: '/bar', key: bar.key, metadata: undefined },
          { data: 'foo1', seq: 0, path: '/foo', key: foo.key, metadata: undefined },
          { data: 'foo2', seq: 1, path: '/foo', key: foo.key, metadata: undefined },
          { data: 'quz1', seq: 0, path: '/quz', key: quz.key, metadata: undefined }
        ]);
      });
      liveStream.destroy();
    }
  });

  test('append event', async (done) => {
    const feedStore = await FeedStore.create(ram);
    const feed = await feedStore.openFeed('/test');

    feedStore.on('append', (f) => {
      expect(f).toBe(feed);
      done();
    });

    feed.append('test');
  });

  test('update metadata', async () => {
    const root = tempy.directory();
    const feedStore = await FeedStore.create(root);
    await feedStore.openFeed('/test', { metadata: { tag: 0 } });
    let descriptor = feedStore.getDescriptors().find(fd => fd.path === '/test');
    await descriptor.setMetadata({ tag: 1 });
    expect(descriptor.metadata).toEqual({ tag: 1 });

    // Check that the metadata was updated in indexdb.
    await feedStore.close();
    await feedStore.open();
    descriptor = feedStore.getDescriptors().find(fd => fd.path === '/test');
    expect(descriptor.metadata).toEqual({ tag: 1 });
  });

  test('openFeed should wait until FeedStore is ready', async () => {
    const feedStore = new FeedStore(ram);
    feedStore.open();
    const feed = await feedStore.openFeed('/test');
    expect(feed).toBeDefined();
  });

  test('createReadStream should destroy if FeedStore is closed', async (done) => {
    const feedStore = new FeedStore(ram);

    const stream = feedStore.createReadStream();
    await new Promise(resolve => eos(stream, err => {
      expect(err.message).toBe('FeedStore closed');
      resolve();
    }));

    await feedStore.open();

    const stream2 = feedStore.createReadStream();
    eos(stream2, err => {
      expect(err.message).toBe('FeedStore closed');
      done();
    });

    await feedStore.close();
  });

  test('createReadStream should destroy if filter throws an error', async () => {
    const feedStore = await FeedStore.create(ram);
    await feedStore.openFeed('/test');

    const stream = feedStore.createReadStream(async () => {
      throw new Error('filter error');
    });
    await new Promise(resolve => eos(stream, err => {
      expect(err.message).toBe('filter error');
      resolve();
    }));
  });

  test('Delete all', async () => {
    const { feedStore } = await createDefault();
    await defaultFeeds(feedStore);

    expect(feedStore.getDescriptors().length).toBe(3);
    await feedStore.deleteAllDescriptors();
    expect(feedStore.getDescriptors().length).toBe(0);
  });
});
