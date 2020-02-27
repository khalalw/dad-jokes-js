/* eslint-disable consistent-return */
/* eslint-disable no-console */
/* eslint-disable no-underscore-dangle */
const client = require('mongodb').MongoClient;
const assert = require('assert');
require('dotenv').config();

let _db;
const { MONGO_CONNECTION_STRING: connectionString } = process.env;

const initDb = callback => {
  if (_db) {
    console.warn('Trying to init DB again!');
    return callback(null, _db);
  }

  const connected = (err, db) => {
    if (err) {
      return callback(err);
    }

    console.log(`DB initialized - connected to ${connectionString.split('@')[1]}`);
    _db = db;
    return callback(null, _db);
  };

  client.connect(connectionString, { useUnifiedTopology: true }, connected);
};

const getDb = () => {
  assert.ok(_db, 'Db has not been initialized. Please call init first');
  return _db;
};

module.exports = {
  getDb,
  initDb
};
