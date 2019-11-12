//
// Copyright 2019 Wireline, Inc.
//

import hypertrie from 'hypertrie';
import tempy from 'tempy';
import ram from 'random-access-memory';
import hypercore from 'hypercore';
import pify from 'pify';

import FeedStore from './feed-store';

describe('feedStore', () => {
  let booksFeed;
  let usersFeed;
  let groupsFeed;
  let feedStore;
  const directory = tempy.directory();

  function createDefault () {
    return FeedStore.create(hypertrie(directory), directory, { feedOptions: { valueEncoding: 'utf-8' } });
  }

  test('Config with db and valueEncoding utf-8', async () => {
    feedStore = await createDefault();

    expect(feedStore).toBeInstanceOf(FeedStore);
  });

  test('Create feed', async () => {
    booksFeed = await feedStore.openFeed('/books');
    expect(booksFeed).toBeInstanceOf(hypercore);
    expect(FeedStore.getDescriptor(booksFeed)).toHaveProperty('path', '/books');
    await pify(booksFeed.append.bind(booksFeed))('Foundation and Empire');
    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');
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
    await feedStore.closeFeed('/groups');
    expect(groupsFeed.closed).toBe(true);
  });

  test('Descriptors', async () => {
    expect(feedStore.getDescriptors().map(fd => fd.path)).toEqual(['/books', '/users', '/groups']);
    expect(feedStore.getOpenedDescriptors().map(fd => fd.path)).toEqual(['/books', '/users']);
    expect(feedStore.getDescriptorByKey(booksFeed.key)).toHaveProperty('path', '/books');
    expect(feedStore.getDescriptorByPath('/books')).toHaveProperty('key', booksFeed.key);
  });

  test('Feeds', async () => {
    expect(feedStore.getFeeds().map(f => f.key)).toEqual([booksFeed.key, usersFeed.key]);
    expect(feedStore.findFeed(fd => fd.key.equals(booksFeed.key))).toBe(booksFeed);
    expect(feedStore.filterFeeds(fd => fd.path === '/books')).toEqual([booksFeed]);
  });

  test('Load feed', async () => {
    const [feed] = await feedStore.loadFeeds(fd => fd.path === '/groups');
    expect(feed).toBeDefined();
    expect(feed.key).toEqual(groupsFeed.key);
    expect(feedStore.getDescriptorByPath('/groups')).toHaveProperty('opened', true);
  });

  test('Close feedStore and their feeds', async () => {
    await feedStore.close();
    expect(feedStore.getOpenedDescriptors().length).toBe(0);
  });

  test('Reopen feedStore and recreate feeds from the indexDB', async () => {
    feedStore = await createDefault();

    expect(feedStore).toBeInstanceOf(FeedStore);
    expect(feedStore.getDescriptors().length).toBe(3);

    const booksFeed = await feedStore.openFeed('/books');
    const [usersFeed] = await feedStore.loadFeeds(fd => fd.path === '/users');
    expect(feedStore.getOpenedDescriptors().length).toBe(2);

    await expect(pify(booksFeed.head.bind(booksFeed))()).resolves.toBe('Foundation and Empire');
    await expect(pify(usersFeed.head.bind(usersFeed))()).resolves.toBe('alice');
  });

  test('Delete descriptor', async () => {
    await feedStore.deleteDescriptor('/books');
    expect(feedStore.getDescriptors().length).toBe(2);
  });

  test('Default codec: binary', async () => {
    const feedStore = await FeedStore.create(hypertrie(ram), ram);
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
        }
      }
    };
    const feedStore = await FeedStore.create(hypertrie(ram), ram, options);
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
});
