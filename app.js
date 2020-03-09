/* eslint-disable no-unused-expressions */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */
require('dotenv').config();

// Environmental Variables
const {
  SUB_COLLECTION: subs,
  JOKE_COLLECTION: prevJokes,
  ACCOUNT_SID: accountSid,
  AUTH_TOKEN: authToken,
  DB: dbName,
  OUTGOING_NUMBER: outgoingNumber,
  PORT: port
} = process.env;

const http = require('http');
const { urlencoded } = require('body-parser');
const app = require('express')();

const {
  twiml: { MessagingResponse }
} = require('twilio');

const client = require('twilio')(accountSid, authToken);
const schedule = require('node-schedule');
const fetch = require('node-fetch');

const { initDb, getDb } = require('./db');
const { optOutKeywords, helpKeywords } = require('./constants');

// Only accepting US numbers
function isNumberValid(phoneNumber) {
  return phoneNumber.length === 12 && phoneNumber.slice(0, 2) === '+1';
}

function handleResponse(incomingMessage) {
  const responses = {
    dad: `Thank you for signing up for your daily dose of dad jokes. You'll receive one joke everyday at around 9AM PST. To opt out at any time, reply with STOP.`,
    help: `Dad Jokes: If you would like to receive an automated joke once a day, reply DAD. To stop receiving messages completely, reply STOP.`
  };
  return responses[incomingMessage] || responses.help;
}

function sendResponse(incomingMessage, outgoingMessage, twiml, res) {
  const response = outgoingMessage || handleResponse(incomingMessage);

  twiml.message(response);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
}

function findRecords(db, record, collectionName) {
  return db
    .collection(collectionName)
    .find(record || null)
    .toArray();
}

function updateDb(db, action, record, collectionName) {
  let logMessage;
  const collection = db.collection(collectionName);
  const [val] = Object.values(record);

  switch (action) {
    case 'insert':
      collection.insertOne(record);
      logMessage = `One document added - ${val}`;
      break;
    case 'delete':
      collection.deleteOne(record);
      logMessage = `One document removed - ${val}`;
      break;
    default:
      throw new Error('Please enter a valid action');
  }

  console.log(logMessage);
}

async function respondToMessage(req, res) {
  const db = getDb().db(dbName);
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body.trim().toLowerCase();
  const phoneNumber = req.body.From;
  let outgoingMessage;
  let dbAction;
  let isOptingOut = false;

  if (helpKeywords.includes(incomingMsg) || !isNumberValid(phoneNumber)) {
    res.end();
  }

  const [record] = await findRecords(db, { phoneNumber }, subs);

  if (record) {
    if (incomingMsg === 'dad') {
      outgoingMessage = `You're already signed up to receive daily dad jokes.`;
    } else if (optOutKeywords.includes(incomingMsg)) {
      isOptingOut = true;
      dbAction = 'delete';
    }
  } else if (incomingMsg === 'dad' && !record) {
    dbAction = 'insert';
  }

  if (dbAction) {
    updateDb(db, dbAction, { phoneNumber }, subs);
    isOptingOut && res.end();
  }

  if (!isOptingOut) {
    sendResponse(incomingMsg, outgoingMessage, twiml, res);
  }
}

// Message scheduling
async function fetchDadJoke() {
  const response = await fetch('https://icanhazdadjoke.com/', {
    headers: { Accept: 'application/json' }
  });
  return response.json();
}

async function prepareDadJoke() {
  const db = getDb().db(dbName);
  let record;
  let joke;
  let isJokeInDb;

  do {
    const { id: jokeId, joke: _joke } = await fetchDadJoke();
    record = { jokeId };

    const [prevJoke] = await findRecords(db, record, prevJokes);
    isJokeInDb = !!prevJoke;

    if (isJokeInDb) {
      console.log('Duplicate joke found, fetching another');
    } else {
      joke = _joke;
    }
  } while (isJokeInDb);

  console.log(`Adding joke to DB`);
  updateDb(db, 'insert', record, prevJokes);
  return joke;
}

async function sendMessage(body, phoneNumber) {
  const createdMessage = await client.messages.create({
    body,
    from: outgoingNumber,
    to: phoneNumber
  });

  const { sid } = createdMessage;
  console.log(`Message sent - ${sid}`);
}

async function sendJokes() {
  console.log('Sending daily message...');
  const db = getDb().db(dbName);
  const joke = await prepareDadJoke();
  const numberList = await findRecords(db, null, subs);

  const date = new Date();
  const day = date.getDate();
  const month = date.getMonth() + 1;

  const message = `Daily Dad Joke - ${month}/${day}:\n\n${joke}`;

  numberList.forEach(({ phoneNumber }) => {
    sendMessage(message, phoneNumber);
  });
}

function setupScheduler(ruleOptions) {
  const rule = new schedule.RecurrenceRule();
  return { ...rule, ...ruleOptions };
}

app.use(urlencoded({ extended: false }));
app.post('/sms', respondToMessage);

initDb(err => {
  http.createServer(app).listen(port, () => {
    if (err) {
      throw err;
    }
    console.log(`Express server listening on port ${port}`);
  });

  (function startSchedule() {
    const scheduleOptions = {
      dayOfWeek: [new schedule.Range(1, 5)],
      hour: 9,
      minute: 0,
      tz: 'US/Pacific'
    };
    const rule = setupScheduler(scheduleOptions);
    console.log('Job scheduled');
    schedule.scheduleJob(rule, () => {
      sendJokes();
    });
  })();
});
