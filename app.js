/* eslint-disable no-unused-expressions */
/* eslint-disable no-console */
require('dotenv').config();
const http = require('http');
const { urlencoded } = require('body-parser');
const app = require('express')();

const { Observable, from, of, combineLatest, forkJoin } = require('rxjs');
const { map, switchMap, tap, take, finalize, retry } = require('rxjs/operators');
const axios = require('axios');

const {
  twiml: { MessagingResponse }
} = require('twilio');
const twilio = require('twilio');
const client = new twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);
const schedule = require('node-schedule');

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

function findRecords$(db, record, collectionName) {
  return from(
    db
      .collection(collectionName)
      .find(record || null)
      .toArray()
  );
}

function updateDb$(db, action, record, collectionName) {
  const collection = db.collection(collectionName);
  const [val] = Object.values(record);

  return of(action).pipe(
    switchMap(action => {
      return from(
        action === 'insert' ? collection.insertOne(record) : collection.deleteOne(record)
      );
    }),
    map(val => !!val.insertedCount),
    tap(res => console.log(`One document ${(res && 'added') || 'removed'} - ${val}`))
  );
}

function respondToMessage(req, res) {
  const db = getDb().db(process.env.DB);
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body.trim().toLowerCase();
  const phoneNumber = req.body.From;
  let outgoingMessage;
  let dbAction;

  if (helpKeywords.includes(incomingMsg) || !isNumberValid(phoneNumber)) {
    res.end();
    return;
  }

  findRecords$(db, { phoneNumber }, process.env.SUB_COLLECTION)
    .pipe(
      map(([record]) => record),
      tap(record => {
        if (record) {
          if (incomingMsg === 'dad') {
            outgoingMessage = `You're already signed up to receive daily dad jokes.`;
          } else if (optOutKeywords.includes(incomingMsg)) {
            dbAction = 'delete';
          }
        }
      }),
      tap(record => {
        if (incomingMsg === 'dad' && !record) {
          dbAction = 'insert';
        }
      }),
      switchMap(() =>
        dbAction ? updateDb$(db, dbAction, { phoneNumber }, process.env.SUB_COLLECTION) : of(true)
      ),
      tap(resAction => resAction && sendResponse(incomingMsg, outgoingMessage, twiml, res)),
      take(1),
      finalize(() => res.end())
    )
    .subscribe();
}

// Message scheduling
function fetchDadJoke$() {
  return new Observable(observer => {
    axios
      .get('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json' } })
      .then(response => {
        observer.next(response.data);
        observer.complete();
      })
      .catch(err => observer.error(err));
  });
}

function prepareDadJoke$() {
  const db = getDb().db(process.env.DB);
  return fetchDadJoke$().pipe(
    switchMap(data =>
      findRecords$(db, { jokeId: data.id }, process.env.JOKE_COLLECTION).pipe(
        map(([prevJoke]) => ({
          prevJoke,
          data
        }))
      )
    ),
    switchMap(({ prevJoke, data }) => {
      if (prevJoke) {
        throw new Error('Joke already used, fetching another...');
      }
      return updateDb$(db, 'insert', { jokeId: data.id }, process.env.JOKE_COLLECTION).pipe(
        map(() => data['joke'])
      );
    }),
    retry(25)
  );
}

function sendMessage$(body, phoneNumber) {
  return from(
    client.messages.create({
      body,
      from: process.env.OUTGOING_NUMBER,
      to: phoneNumber
    })
  ).pipe(map(({ sid }) => `Message sent - ${sid}`));
}

function sendJokes() {
  console.log('Sending daily jokes...');
  const db = getDb().db(process.env.DB);

  const date = new Date();
  const day = date.getDate();
  const month = date.getMonth() + 1;

  combineLatest([findRecords$(db, null, process.env.SUB_COLLECTION), prepareDadJoke$()])
    .pipe(
      switchMap(([numberList, joke]) => {
        const message = `Daily Dad Joke - ${month}/${day}:\n\n${joke}`;
        return forkJoin(numberList.map(({ phoneNumber }) => sendMessage$(message, phoneNumber)));
      }),
      tap(messagesLogs => messagesLogs.forEach(message => console.log(message))),
      take(1),
      finalize(() => console.log('Daily jokes sent'))
    )
    .subscribe();
}

function setupScheduler(ruleOptions) {
  const rule = new schedule.RecurrenceRule();
  return { ...rule, ...ruleOptions };
}

app.use(urlencoded({ extended: false }));
app.post('/sms', respondToMessage);

initDb(err => {
  http.createServer(app).listen(process.env.PORT, () => {
    if (err) {
      throw err;
    }
    console.log(`Express server listening on port ${process.env.PORT}`);

    (function startSchedule() {
      const scheduleOptions = {
        dayOfWeek: [new schedule.Range(1, 5)],
        hour: 9,
        minute: 0,
        tz: 'US/Pacific'
      };
      const rule = setupScheduler(scheduleOptions);
      console.log('Job scheduled');
      schedule.scheduleJob(rule, sendJokes);
    })();
  });
});
