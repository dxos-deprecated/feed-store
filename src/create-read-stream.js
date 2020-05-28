import streamFrom from 'from2';

export default function createReadStream (feed, opts = {}) {
  var start = opts.start || 0;
  var end = typeof opts.end === 'number' ? opts.end : -1;
  var live = !!opts.live;
  var snapshot = opts.snapshot !== false;
  var batch = opts.batch || 100;
  var batchEnd = 0;
  var batchLimit = 0;

  var first = true;
  var range = feed.download({ start: start, end: end, linear: true });

  var stream = streamFrom.obj(read).on('end', cleanup).on('close', cleanup);

  return stream;

  function read (size, cb) {
    if (!feed.opened) return open(size, cb);
    if (!feed.readable) return cb(new Error('Feed is closed'));

    if (first) {
      if (end === -1) {
        if (live) end = Infinity;
        else if (snapshot) end = feed.length;
        if (start > end) return cb(null, null);
      }
      if (opts.tail) start = feed.length;
      first = false;
    }

    if (start === end || (end === -1 && start === feed.length)) {
      return cb(null, null);
    }

    if (batch === 1) {
      feed.get(setStart(start + 1), opts, cb);
      return;
    }

    batchEnd = start + batch;
    batchLimit = end === Infinity ? feed.length : end;
    if (batchEnd > batchLimit) {
      batchEnd = batchLimit;
    }

    if (!feed.downloaded(start, batchEnd)) {
      feed.get(setStart(start + 1), opts, cb);
      return;
    }

    feed.getBatch(setStart(batchEnd), batchEnd, opts, (err, result) => {
      if (err || result.length === 0) {
        cb(err);
        return;
      }

      var lastIdx = result.length - 1;
      for (var i = 0; i < lastIdx; i++) {
        stream.push(result[i]);
      }
      cb(null, result[lastIdx]);
    });
  }

  function cleanup () {
    if (!range) return;
    feed.undownload(range);
    range = null;
  }

  function open (size, cb) {
    feed.ready(function (err) {
      if (err) return cb(err);
      read(size, cb);
    });
  }

  function setStart (value) {
    var prevStart = start;
    start = value;
    range.start = start;
    if (range.iterator) {
      range.iterator.start = start;
    }
    return prevStart;
  }
}
