/**
 * POST /api/twilio/connect
 * TwiML webhook — when the lead's phone is answered, this connects
 * them to the agent's browser via Twilio Client.
 *
 * Query params: agentIdentity, leadId, line
 */
const twilio = require('twilio');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const agentIdentity = req.query.agentIdentity || req.body?.agentIdentity || 'aiis-agent';
  const leadId = req.query.leadId || req.body?.leadId || '';
  const line = req.query.line || req.body?.line || '1';
  const answeredBy = req.body?.AnsweredBy || '';

  const twiml = new twilio.twiml.VoiceResponse();

  // Check answering machine detection
  if (answeredBy === 'machine_start' || answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'fax') {
    // It's a voicemail or machine — optionally leave a message
    if (answeredBy === 'machine_end_beep') {
      twiml.say(
        { voice: 'Polly.Matthew' },
        'Hi, this is Advanced Insurance Solutions calling about your commercial trucking insurance. ' +
        'We work with over 50 A-rated carriers and can typically save you 15 to 20 percent. ' +
        'Please call us back at 6 5 7, 3 6 6, 5 3 1 2. Or visit fleet dot ins2day dot com for a free quote. Thank you!'
      );
      twiml.hangup();
    } else {
      // machine_start or fax — just hang up
      twiml.hangup();
    }
  } else {
    // Human answered — connect them to the agent's browser
    const dial = twiml.dial({ timeout: 5 });
    dial.client(
      {
        statusCallbackEvent: 'initiated ringing answered completed',
        statusCallback: '/api/twilio/status?leadId=' + leadId + '&line=' + line
      },
      agentIdentity
    );
  }

  return res.status(200).send(twiml.toString());
};
