/* eslint-disable no-console */
require('dotenv').config();

const http = require('http');
const { urlencoded } = require('body-parser');
const app = require('express')();

const {
  twiml: { MessagingResponse }
} = require('twilio');

const client = require('twilio')(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);
const schedule = require('node-schedule');
const fetch = require('node-fetch');

const { initDb, getDb } = require('./db');
const { optOutKeywords, helpKeywords } = require('./constants');

function isNumberValid(phoneNumber) {
  return phoneNumber.length === 12 && phoneNumber.slice(0, 2) === '+1';
}

function handleResponse(incomingMessage) {
  const responses = {
    dad: `Thank you for signing up for you daily dose of dad jokes. You'll receive one joke everyday. To opt out at any time, reply with STOP or 9.`,
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

function findRecord(db, phoneNumber) {
  return db
    .collection(process.env.COLLECTION)
    .find({ phoneNumber })
    .toArray();
}

function updateDb(db, action, phoneNumber) {
  let logMessage;
  const collection = db.collection(process.env.COLLECTION);
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
      logMessage = 'Please enter a valid action';
  }

  console.log(logMessage);
}

function respondToMessage(req, res) {
  const db = getDb().db(process.env.DB);
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body.trim().toLowerCase();
  const phoneNumber = req.body.From;

  if (helpKeywords.includes(incomingMsg) || !isNumberValid(phoneNumber)) {
    res.end();
  }

  findRecord(db, phoneNumber).then(
    val => {
      if (val.length) {
        if (incomingMsg === 'dad') {
          sendResponse(null, `You're already signed up to receive daily dad jokes.`, twiml, res);
        } else if (optOutKeywords.includes(incomingMsg)) {
          updateDb(db, 'delete', phoneNumber);
        }
      } else if (incomingMsg === 'dad' && !val.length) {
        updateDb(db, 'insert', phoneNumber);
        sendResponse(incomingMsg, null, twiml, res);
      } else {
        sendResponse(incomingMsg, null, twiml, res);
      }
    },
    err => {
      throw new Error(err);
    }
  );
}

function sendMessage(body, phoneNumber) {
  client.messages
    .create({
      body,
      from: process.env.OUTGOING_NUMBER,
      to: phoneNumber
    })
    .then(({ sid }) => console.log(`Messages sent - ${sid}`));
}

async function getDadJoke() {
  const response = await fetch('https://icanhazdadjoke.com/', {
    headers: { Accept: 'application/json' }
  });
  return response.json();
}

async function sendJokes() {
  console.log('Sending daily message...');
  const { joke } = await getDadJoke();

  getDb()
    .db(process.env.DB)
    .collection(process.env.COLLECTION)
    .find()
    .toArray()
    .then(list => {
      list.forEach(({ phoneNumber }) => sendMessage(joke, phoneNumber));
    });
}

function setupScheduler() {
  const rule = new schedule.RecurrenceRule();
  rule.dayOfWeek = [new schedule.Range(1, 5)];
  rule.hour = 9;
  rule.minute = 0;
  rule.tz = 'US/Pacific';
  return rule;
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
