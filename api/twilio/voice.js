/**
 * POST /api/twilio/voice
 * TwiML webhook — Twilio hits this when the browser-initiated call connects.
 * Routes the call: dials the lead and conferences them with the agent.
 *
 * This is a Twilio WEBHOOK — called by Twilio servers, not by the browser.
 * No API key auth required, but CORS is restricted.
 */
const twilio = require('twilio');
const { setCorsHeaders } = require('./auth');

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  res.setHeader('Content-Type', 'text/xml');

  const body = req.body || {};
  const to = body.To || body.to;
  const callerId = body.callerId || body.CallerID || body.From;
  const conferenceId = body.conferenceId;

  const twiml = new twilio.twiml.VoiceResponse();

  if (to && to !== '' && !to.startsWith('client:')) {
    // Outbound call to a real phone number
    // Put both parties in a conference so the agent can hear + talk
    if (conferenceId) {
      const dial = twiml.dial({ callerId: callerId, timeout: 30, answerOnBridge: true });
      dial.conference({
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        statusCallback: '/api/twilio/status',
        statusCallbackEvent: 'start end join leave'
      }, conferenceId);
    } else {
      // Direct dial
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
    // Incoming call to agent's browser
    const dial = twiml.dial();
    dial.client(to.replace('client:', ''));
  } else {
    twiml.say('No destination specified.');
  }

  return res.status(200).send(twiml.toString());
};
