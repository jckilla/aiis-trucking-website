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
const { setCorsHeaders } = require('../../lib/twilio-auth');

// All inbound callbacks are forwarded to this number.
const FORWARD_NUMBER = '+19499698505';

// SECURITY: this TwiML webhook is publicly reachable, so its outbound-bridge branch is
// restricted to valid US, non-premium destinations with a valid US caller ID — mirroring
// the checks in /api/twilio/dial — so it cannot be abused for premium/international toll
// fraud or to echo a garbage/injected caller ID.
const US_PHONE_REGEX = /^\+1[2-9]\d{9}$/;
const PREMIUM_PREFIXES = ['+1900', '+1976'];
function normalizeUsPhone(p) {
  if (!p) return null;
  let d = String(p).replace(/\D/g, '');
  if (d.length === 10) d = '1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}
function isBlockedUsPhone(e164) {
  if (!e164 || !US_PHONE_REGEX.test(e164)) return true;
  return PREMIUM_PREFIXES.some((pre) => e164.startsWith(pre));
}

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
    // Restrict outbound bridging to valid US, non-premium destinations with a valid US
    // caller ID (see the SECURITY note at the top of this file).
    const e164To = normalizeUsPhone(to);
    if (isBlockedUsPhone(e164To)) {
      twiml.say({ voice: 'Polly.Joanna' }, 'This destination is not allowed.');
      return res.status(200).send(twiml.toString());
    }
    const dialCallerId = normalizeUsPhone(callerId);
    if (!dialCallerId) {
      twiml.say({ voice: 'Polly.Joanna' }, 'A valid caller ID is required.');
      return res.status(200).send(twiml.toString());
    }
    if (conferenceId) {
      const dial = twiml.dial({ callerId: dialCallerId, timeout: 30, answerOnBridge: true });
      dial.conference({
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        statusCallback: '/api/twilio/status',
        statusCallbackEvent: 'start end join leave'
      }, conferenceId);
    } else {
      const dial = twiml.dial({
        callerId: dialCallerId,
        timeout: 30,
        answerOnBridge: true,
        action: '/api/twilio/status'
      });
      dial.number({
        statusCallback: '/api/twilio/status',
        statusCallbackEvent: 'initiated ringing answered completed'
      }, e164To);
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
