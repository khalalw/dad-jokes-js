/* eslint-disable no-console */
require('dotenv').config();

// Environmental Variables
const {
  COLLECTION: collectionName,
  ACCOUNT_SID: accountSid,
  AUTH_TOKEN: authToken,
  DB: dbName,
  OUTGOING_NUMBER: outgoingNumber
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
    dad: `Thank you for signing up for you daily dose of dad jokes. You'll receive one joke everyday. To opt out at any time, reply with STOP.`,
    help: `Dad Jokez: If you would like to receive an automated joke once a day, reply DAD. To stop receiving messages completely, reply STOP.`
  };
  return responses[incomingMessage] || responses.help;
}

function sendResponse(incomingMessage, outgoingMessage, twiml, res) {
  const response = outgoingMessage || handleResponse(incomingMessage);

  twiml.message(response);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
}

function findRecords(db, phoneNumber) {
  return db
    .collection(collectionName)
    .find(phoneNumber ? { phoneNumber } : null)
    .toArray();
}

function updateDb(db, action, phoneNumber) {
  let logMessage;
  const collection = db.collection(collectionName);
  switch (action) {
    case 'insert':
      collection.insertOne({ phoneNumber });
      logMessage = `One document added - ${phoneNumber}`;
      break;
    case 'delete':
      collection.deleteOne({ phoneNumber });
      logMessage = `One document removed - ${phoneNumber}`;
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

  if (helpKeywords.includes(incomingMsg) || !isNumberValid(phoneNumber)) {
    res.end();
  }

  const [record] = await findRecords(db, phoneNumber);

  if (record) {
    if (incomingMsg === 'dad') {
      sendResponse(null, `You're already signed up to receive daily dad jokes.`, twiml, res);
    } else if (optOutKeywords.includes(incomingMsg)) {
      updateDb(db, 'delete', phoneNumber);
    }
  } else if (incomingMsg === 'dad' && !record) {
    updateDb(db, 'insert', phoneNumber);
    sendResponse(incomingMsg, null, twiml, res);
  } else {
    sendResponse(incomingMsg, null, twiml, res);
  }
}

// Message scheduling
async function getDadJoke() {
  const response = await fetch('https://icanhazdadjoke.com/', {
    headers: { Accept: 'application/json' }
  });
  return response.json();
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
  const { joke } = await getDadJoke();
  const db = getDb().db(dbName);
  const numberList = await findRecords(db);

  numberList.forEach(({ phoneNumber }) => {
    sendMessage(joke, phoneNumber);
  });
}

function setupScheduler() {
  const rule = new schedule.RecurrenceRule();
  return { ...rule, dayOfWeek: [new schedule.Range(1, 5)], hour: 18, minute: 0, tz: 'US/Pacific' };
}

(function startSchedule() {
  const rule = setupScheduler();
  schedule.scheduleJob(rule, () => {
    sendJokes();
  });
})();

app.use(urlencoded({ extended: false }));
app.post('/sms', respondToMessage);

initDb(err => {
  http.createServer(app).listen(8000, () => {
    if (err) {
      throw err;
    }

    console.log('Express server listening on port 8000');
  });
});
