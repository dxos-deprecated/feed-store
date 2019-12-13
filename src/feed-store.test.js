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

describe('FeedStore', () => {
  let booksFeed;
  let usersFeed;
  let groupsFeed;
  let feedStore;
  const directory = tempy.directory();

  function createDefault () {
    return FeedStore.create(directory, { feedOptions: { valueEncoding: 'utf-8' } });
  }

  test('Config default', async () => {
    const feedStore = await FeedStore.create(ram);
    expect(feedStore).toBeInstanceOf(FeedStore);
    expect(feedStore.opened).toBeTruthy();

    const feedStore2 = new FeedStore(ram);
    expect(feedStore).toBeInstanceOf(FeedStore);
    feedStore2.initialize();
    await expect(feedStore2.ready()).resolves.toBeUndefined();
    expect(feedStore.opened).toBeTruthy();
  });

  test('Should throw an assert error creating without storage.', async () => {
    await expect(FeedStore.create()).rejects.toThrow(/storage is required/);
  });

  test('Config default and valueEncoding utf-8', async () => {
    feedStore = await createDefault();

    expect(feedStore).toBeInstanceOf(FeedStore);
  });

  test('Create feed', async () => {
    const metadata = { topic: 'books' };
    booksFeed = await feedStore.openFeed('/books', { metadata });
    expect(booksFeed).toBeInstanceOf(hypercore);
    const booksFeedDescriptor = feedStore.getDescriptors().find(fd => fd.path === '/books');
    expect(booksFeedDescriptor).toHaveProperty('path', '/books');
    expect(booksFeedDescriptor.metadata).toEqual(metadata);
    await pify(booksFeed.append.bind(booksFeed))('Foundation and Empire');
    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');
    // It should return the same opened instance.
    await expect(feedStore.openFeed('/books')).resolves.toBe(booksFeed);
    // You can't open a feed with a different key.
    await expect(feedStore.openFeed('/books', { key: Buffer.from('...') })).rejects.toThrow(/Invalid public key/);
    await expect(feedStore.openFeed('/foo', { key: booksFeed.key })).rejects.toThrow(/Feed exists/);

    // Create a reader feed from key
    const feedStore2 = await FeedStore.create(ram);
    const readerFeed = await feedStore2.openFeed('/reader', { key: booksFeed.key });
    expect(readerFeed).toBeInstanceOf(hypercore);
  });

  test('Create duplicate feed', async () => {
    const [feed1, feed2] = await Promise.all([feedStore.openFeed('/users'), feedStore.openFeed('/users')]);
    expect(feed1).toBe(feed2);
    usersFeed = feed1;
    groupsFeed = await feedStore.openFeed('/groups');

    await pify(usersFeed.append.bind(usersFeed))('alice');
    await expect(pify(usersFeed.head.bind(usersFeed))()).resolves.toBe('alice');
  });

  test('Create and close a feed', async () => {
    await expect(feedStore.closeFeed('/fooo')).rejects.toThrow(/Feed not found/);
    await feedStore.closeFeed('/groups');
    expect(groupsFeed.closed).toBeTruthy();
  });

  test('Config default + custom database + custom hypercore', async () => {
    const customHypercore = jest.fn((...args) => {
      return hypercore(...args);
    });

    const database = hypertrie(ram, { valueEncoding: 'json' });
    database.list = jest.fn((_, cb) => cb(null, []));

    const feedStore = await FeedStore.create(ram, {
      database,
      hypercore: customHypercore
    });

    expect(feedStore).toBeInstanceOf(FeedStore);
    expect(database.list.mock.calls.length).toBe(1);

    await feedStore.openFeed('/test');

    expect(customHypercore.mock.calls.length).toBe(1);
  });

  test('Descriptors', async () => {
    expect(feedStore.getDescriptors().map(fd => fd.path)).toEqual(['/books', '/users', '/groups']);
  });

  test('Feeds', async () => {
    expect(feedStore.getOpenFeeds().map(f => f.key)).toEqual([booksFeed.key, usersFeed.key]);
    expect(feedStore.getOpenFeed(fd => fd.key.equals(booksFeed.key))).toBe(booksFeed);
    expect(feedStore.getOpenFeed(() => false)).toBeUndefined();
    expect(feedStore.getOpenFeeds(fd => fd.path === '/books')).toEqual([booksFeed]);
  });

  test('Load feed', async () => {
    const [feed] = await feedStore.openFeeds(fd => fd.path === '/groups');
    expect(feed).toBeDefined();
    expect(feed.key).toEqual(groupsFeed.key);
    expect(feedStore.getDescriptors().find(fd => fd.path === '/groups')).toHaveProperty('opened', true);
  });

  test('Close feedStore and their feeds', async () => {
    await feedStore.close();
    expect(feedStore.getDescriptors().filter(fd => fd.opened).length).toBe(0);
    expect(feedStore.opened).toBe(false);
  });

  test('Reopen feedStore and recreate feeds from the indexDB', async () => {
    feedStore = await createDefault();

    expect(feedStore).toBeInstanceOf(FeedStore);
    expect(feedStore.getDescriptors().length).toBe(3);

    const booksFeed = await feedStore.openFeed('/books');
    const [usersFeed] = await feedStore.openFeeds(fd => fd.path === '/users');
    expect(feedStore.getDescriptors().filter(fd => fd.opened).length).toBe(2);

    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');
    await expect(pify(usersFeed.head.bind(usersFeed))()).resolves.toBe('alice');

    // The metadata of /books should be recreate too.
    const metadata = { topic: 'books' };
    expect(feedStore.getDescriptors().find(fd => fd.path === '/books').metadata).toEqual(metadata);
  });

  test('Delete descriptor', async () => {
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

    const foo = await feedStore.openFeed('/foo');
    const bar = await feedStore.openFeed('/bar');
    await Promise.all([
      pify(foo.append.bind(foo))('foo1'),
      pify(bar.append.bind(bar))('bar1')
    ]);

    const stream = feedStore.createReadStream();

    const messages = [];
    stream.on('data', (chunk) => {
      messages.push(chunk.toString('utf8'));
    });

    const liveStream1 = testLiveStream({ live: true });
    const liveStream2 = testLiveStream({ live: false }, () => ({ live: true }));

    await eos(stream);
    expect(messages.sort()).toEqual(['bar1', 'foo1']);

    const quz = await feedStore.openFeed('/quz');
    await pify(quz.append.bind(quz))('quz1');

    await Promise.all([liveStream1, liveStream2]);

    async function testLiveStream (...args) {
      const liveMessages = [];
      const liveStream = feedStore.createReadStream(...args);
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
    const feedStore = await FeedStore.create(ram);

    const foo = await feedStore.openFeed('/foo', { metadata: { topic: 'topic1' } });
    const bar = await feedStore.openFeed('/bar');

    await Promise.all([
      pify(foo.append.bind(foo))('foo1'),
      pify(bar.append.bind(bar))('bar1')
    ]);

    const stream = feedStore.createReadStream(({ metadata = {}, feed }) => {
      if (metadata.topic === 'topic1') {
        return feed.createReadStream();
      }
    });
    const liveStream1 = testLiveStream(({ metadata = {} }) => {
      if (metadata.topic === 'topic1') {
        return { live: true };
      }
    });
    const liveStream2 = testLiveStream({ live: false }, ({ metadata = {} }) => {
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

    await Promise.all([liveStream1, liveStream2]);

    async function testLiveStream (...args) {
      const liveMessages = [];
      const liveStream = feedStore.createReadStream(...args);

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

    const stream = feedStore.createReadStream({ feedStoreInfo: true }, descriptor => {
      if (descriptor.path === '/foo') {
        return { start: 1 };
      }

      return {};
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
});
