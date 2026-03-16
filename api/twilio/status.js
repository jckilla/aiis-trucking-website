/**
 * POST /api/twilio/status
 * Twilio call status webhook — receives call lifecycle events.
 * Logs call progress and final disposition.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const body = req.body || {};
  const {
    CallSid,
    CallStatus,
    CallDuration,
    AnsweredBy,
    From,
    To,
    Direction
  } = body;

  const leadId = req.query.leadId || body.leadId || '';
  const line = req.query.line || body.line || '';

  console.log(`[Call Status] SID=${CallSid} Status=${CallStatus} AnsweredBy=${AnsweredBy || 'N/A'} Duration=${CallDuration || 0}s Lead=${leadId} Line=${line}`);

  // We just log — the browser polls call status or receives events via Client SDK
  return res.status(200).json({ received: true });
};
