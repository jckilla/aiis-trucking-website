/**
 * POST /api/twilio/connect
 * TwiML webhook — when the lead's phone is answered, this connects
 * them to the agent's browser via Twilio Client.
 *
 * Query params: agentIdentity, leadId, line
 *
 * Passes leadId and line as custom parameters so the browser SDK
 * can identify which dialer line this call belongs to.
 */
const twilio = require('twilio');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const agentIdentity = req.query.agentIdentity || req.body?.agentIdentity || 'aiis-agent';
  const leadId = req.query.leadId || req.body?.leadId || '';
  const line = req.query.line || req.body?.line || '1';
  const answeredBy = req.body?.AnsweredBy || '';
  const from = req.body?.From || '';

  console.log(`Connect webhook: line=${line}, leadId=${leadId}, answeredBy=${answeredBy}, from=${from}`);

  const twiml = new twilio.twiml.VoiceResponse();

  // Check answering machine detection
  if (answeredBy === 'machine_start' || answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'fax') {
    console.log(`Machine detected on line ${line}: ${answeredBy}`);
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
    console.log(`Human answered on line ${line}! Bridging to client:${agentIdentity}`);
    const dial = twiml.dial({ timeout: 10 });
    const client = dial.client(
      {
        statusCallbackEvent: 'initiated ringing answered completed',
        statusCallback: '/api/twilio/status?leadId=' + leadId + '&line=' + line
      },
      agentIdentity
    );
    // Pass custom parameters so the browser can identify which line connected
    client.parameter({ name: 'leadId', value: leadId });
    client.parameter({ name: 'line', value: line });
    client.parameter({ name: 'from', value: from });
  }

  return res.status(200).send(twiml.toString());
};
