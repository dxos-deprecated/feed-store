//
// Copyright 2019 Wireline, Inc.
//

import pify from 'pify';

/**
 * Index feed descriptors.
 */
class IndexDB {
  /**
   * @constructor
   * @param {HyperTrie} db
   * @param {object} codec
   */
  constructor (db, codec) {
    console.assert(db);
    console.assert(codec);

    this._db = {
      ready: pify(db.ready.bind(db)),
      put: pify(db.put.bind(db)),
      get: pify(db.get.bind(db)),
      delete: pify(db.del.bind(db)),
      list: pify(db.list.bind(db)),
      close: pify(db.feed.close.bind(db.feed))
    };

    this._codec = codec;
  }

  async list (path) {
    const list = await this._db.list(`${path}/`);
    return list.map(({ value }) => this._codec.decode(value));
  }

  async get (key) {
    const item = await this._db.get(key);
    return item && this._codec.decode(item.value);
  }

  async put (key, value) {
    return this._db.put(key, this._codec.encode(value));
  }

  async delete (key) {
    return this._db.delete(key);
  }

  async close () {
    return this._db.close();
  }
}

export default IndexDB;
