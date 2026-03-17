/**
 * POST /api/twilio/voice
 * TwiML webhook — handles both outbound calls from the browser
 * AND inbound calls to Twilio numbers.
 *
 * Outbound: Routes the call to the destination number.
 * Inbound: When someone calls the (213) number back, forward to Veronica's cell.
 *
 * This is a Twilio WEBHOOK — called by Twilio servers, not by the browser.
 * No API key auth required, but CORS is restricted.
 */
const twilio = require('twilio');
const { setCorsHeaders } = require('./auth');

// Veronica's personal cell for callback forwarding
const FORWARD_NUMBER = process.env.FORWARD_NUMBER || '+16573665312';

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  res.setHeader('Content-Type', 'text/xml');

  const body = req.body || {};
  const to = body.To || body.to;
  const from = body.From || body.from;
  const direction = body.Direction || body.direction || '';
  const callerId = body.callerId || body.CallerID || body.From;
  const conferenceId = body.conferenceId;

  const twiml = new twilio.twiml.VoiceResponse();

  // INBOUND CALL — someone is calling one of our Twilio numbers
  // If 'To' is one of our Twilio numbers (not a client: and Direction is inbound)
  const isInbound = direction === 'inbound' || (to && to.startsWith('+1213'));

  if (isInbound && !body.callerId && !conferenceId) {
    console.log(`Inbound call from ${from} to ${to} — forwarding to ${FORWARD_NUMBER}`);
    twiml.say(
      { voice: 'Polly.Joanna' },
      'Thank you for calling Advanced Insurance Solutions. Please hold while we connect you.'
    );
    const dial = twiml.dial({
      callerId: to, // Show the Twilio number as caller ID
      timeout: 30,
      answerOnBridge: true
    });
    dial.number(FORWARD_NUMBER);
    // If no answer, go to voicemail message
    twiml.say(
      { voice: 'Polly.Joanna' },
      'Sorry, we missed your call. Please leave a message after the beep, or visit fleet dot ins2day dot com for an instant quote.'
    );
    twiml.record({ maxLength: 120, transcribe: true });
    return res.status(200).send(twiml.toString());
  }

  // OUTBOUND CALL — browser initiated
  if (to && to !== '' && !to.startsWith('client:')) {
    if (conferenceId) {
      const dial = twiml.dial({ callerId: callerId, timeout: 30, answerOnBridge: true });
      dial.conference({
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        statusCallback: '/api/twilio/status',
        statusCallbackEvent: 'start end join leave'
      }, conferenceId);
    } else {
      const dial = twiml.dial({
        callerId: callerId,
        timeout: 30,
        answerOnBridge: true,
        action: '/api/twilio/status'
      });
      dial.number({
        statusCallback: '/api/twilio/status',
        statusCallbackEvent: 'initiated ringing answered completed'
      }, to);
    }
  } else if (to && to.startsWith('client:')) {
    // Call to agent's browser client
    const dial = twiml.dial();
    dial.client(to.replace('client:', ''));
  } else {
    twiml.say('No destination specified.');
  }

  return res.status(200).send(twiml.toString());
};
