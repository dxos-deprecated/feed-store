import crypto from 'hypercore-crypto';

function keyToBuffer(key) {
  if (!key) {
    throw new Error('The `key` is empty.');
  }

  return Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
}

function keyToHex(key) {
  if (!key) {
    throw new Error('The `key` is empty.');
  }

  if (Buffer.isBuffer(key)) {
    return key.toString('hex');
  }

  return key;
}


function getDiscoveryKey(key) {
  return crypto.discoveryKey(keyToBuffer(key));
}

export { keyToBuffer, keyToHex, getDiscoveryKey };
