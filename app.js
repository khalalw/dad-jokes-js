require('dotenv').config();

const http = require('http');
const { urlencoded } = require('body-parser');

const MessagingResponse = require('twilio').twiml.MessagingResponse;
const client = require('twilio')(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);
const schedule = require('node-schedule');
const fetch = require('node-fetch');

const { initDb, getDb } = require('./db');
const { optOutKeywords, helpKeywords } = require('./constants');

const app = require('express')();
app.use(urlencoded({ extended: false }));
app.post('/sms', respondToMessage);

function setupScheduler() {
  const rule = new schedule.RecurrenceRule();
  rule.dayOfWeek = [new schedule.Range(1, 5)];
  rule.hour = 2;
  rule.minute = 25;
  rule.tz = 'US/Pacific';
  return rule;
}

(function sendJokes() {
  const rule = setupScheduler();
  schedule.scheduleJob(rule, () => {
    sendDailyMessage(client);
  });
})();

async function sendDailyMessage(client) {
  console.log('Sending daily message...');
  const { joke } = await getDadJoke();

  getDb()
    .db(process.env.DB)
    .collection(process.env.COLLECTION)
    .find()
    .toArray()
    .then(list => {
      list.forEach(({ phoneNumber }) => {
        client.messages
          .create({
            body: joke,
            from: process.env.OUTGOING_NUMBER,
            to: phoneNumber
          })
          .then(({ sid }) => console.log(`Messages sent - ${sid}`));
      });
    });

  async function getDadJoke() {
    const response = await fetch('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json' } });
    return await response.json();
  }
}

function respondToMessage(req, res) {
  const db = getDb().db(process.env.DB);
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body.trim().toLowerCase();
  const phoneNumber = req.body.From;

  if (helpKeywords.includes(incomingMsg) || !isNumberValid(phoneNumber)) {
    res.end();
  }

  if (incomingMsg === 'dad') {
    findRecord(phoneNumber).then(
      val => {
        if (val.length) {
          sendMessage(null, `You're already signed up to receive daily dad jokes.`);
        } else {
          updateDb(phoneNumber, 'insert');
          sendMessage(incomingMsg);
        }
      },
      err => {
        throw new Error(err);
      }
    );
  } else if (optOutKeywords.includes(incomingMsg)) {
    findRecord(phoneNumber).then(
      val => {
        if (val.length) {
          updateDb(phoneNumber, 'delete');
        }
      },
      err => {
        throw new Error(err);
      }
    );
  } else {
    sendMessage(incomingMsg);
  }

  function sendMessage(incomingMessage, outgoingMessage) {
    const response = outgoingMessage || handleResponse(incomingMessage);
    twiml.message(response);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }

  function handleResponse(incomingMessage) {
    const responses = {
      dad: `Thank you for signing up for you daily dose of dad jokes. 
              You'll receive one joke everyday. To opt out at any time, reply with STOP or 9.`,
      '9': `You are now unsubscribed from receiving daily dad jokes.`,
      '7': `Dad Jokez: If you would like to receive an automadted joke once a day, reply DAD. 
              To stop receiving messages completely, reply STOP.`
    };
    return responses[incomingMessage] || responses['7'];
  }

  function findRecord(phoneNumber) {
    return db
      .collection(process.env.COLLECTION)
      .find({ phoneNumber })
      .toArray();
  }

  function updateDb(phoneNumber, action) {
    let logMessage;
    const collection = db.collection(process.env.COLLECTION);
    switch (action) {
      case 'insert':
        collection.insertOne({ phoneNumber });
        logMessage = 'One document added';
        break;
      case 'delete':
        collection.deleteOne({ phoneNumber });
        logMessage = 'One document removed';
    }

    console.log(logMessage);
  }

  function isNumberValid(phoneNumber) {
    return phoneNumber.length === 12 && phoneNumber.slice(0, 2) === '+1';
  }
}

initDb(err => {
  http.createServer(app).listen(8000, () => {
    if (err) {
      throw err;
    }

    console.log('Express server listening on port 8000');
  });
});
