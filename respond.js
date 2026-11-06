// respond.js — RULE-BASED responder for the two-way room-service call.
// No LLM, no API key. Matches the staff's transcribed speech against
// patterns and returns a response key (a pre-generated Chatty Porch
// MP3 in audio/) or a special action.
//
// Response keys (audio/<key>.mp3, all Chatty Porch):
//   ack       — "Great, thank you."            (generic acknowledgement)
//   everything— "Yes, that's everything. Thanks so much!"
//   room      — "Room 6131."
//   name      — "Chris Dyer."
//   time_ack  — "Perfect, thank you so much!"  (staff gave a wait time)
//   skip      — "Oh, no problem — just skip that one, thanks."
//   goodbye   — "Thank you so much! Have a great night!"
//   fallback  — "Sorry, could you repeat that?"
//
// Special actions:
//   { action: 'repeat' }  — replay the order audio (staff asked to repeat)
//   { action: 'hangup' }  — staff said goodbye; thank them, then hang up
//   { action: 'none' }    — empty/noise transcript; stay silent, keep listening
//
// respond(transcript, order) -> { key } | { action }.
// `order` is the order context { room, guest, items, deliveryNotes }.
// The responder never stays silent on real speech and never hangs up
// mid-conversation except after a goodbye (or an explicit end).

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function respond(transcript, order) {
  const t = normalize(transcript);
  if (!t) return { action: 'none' };
  // Ignore very short noise / single filler words with no meaning.
  if (/^(uh|um|hmm|mm|ah|oh)$/.test(t)) return { action: 'none' };

  // Goodbye / closing — thank them and end. Check first so a
  // "thank you, goodbye" is treated as an ending, not a question.
  if (/\b(goodbye|good bye|bye|have a (good|great|nice)|enjoy|thank you so much|you'?re welcome|you are welcome)\b/.test(t)) {
    return { key: 'goodbye', action: 'hangup' };
  }
  // "Is that everything?" / "Anything else?"
  if (/\b(anything else|anything more|anything other|is that (everything|all|it)|that'?s (all|everything|it)|would that be all|anything to add)\b/.test(t)) {
    return { key: 'everything' };
  }
  // "What room?" / "Room number?"
  if (/\b(room|room number|which room|what room)\b/.test(t)) {
    return { key: 'room' };
  }
  // "What's your name?" / "Last name?"
  if (/\b(your name|last name|what'?s (the|your) name|who is this|who am i speaking|your last name|name please|may i have your name)\b/.test(t)) {
    return { key: 'name' };
  }
  // Staff gave a wait time ("20 minutes", "twenty minutes", "half an
  // hour", "right away", "soon"). Whisper often spells numbers as words,
  // so match the time unit, not just digits.
  if (/\b(minutes?|mins?|hours?|half an hour|right away|soon)\b/.test(t)) {
    return { key: 'time_ack' };
  }
  // Staff says an item is unavailable.
  if (/\b(don'?t have|do not have|not available|we'?re out|out of|no more|we don'?t|unavailable|sold out|can'?t do that)\b/.test(t)) {
    return { key: 'skip' };
  }
  // Staff asked us to repeat the order.
  if (/\b(repeat|say that again|one more time|what was that|pardon|could you repeat|say it again|come again|didn'?t (hear|catch|get) that)\b/.test(t)) {
    return { action: 'repeat' };
  }
  // Generic acknowledgement / greeting / "go ahead" — the staff is
  // listening or confirming; acknowledge briefly and keep listening.
  if (/\b(hello|hi\b|hey|yes\b|yeah|yep|okay|ok\b|sure|go ahead|uh.?huh|alright|all right|i see|got it|understood|mm.?hm)\b/.test(t)) {
    return { key: 'ack' };
  }
  // Anything else we heard but can't classify — ask them to repeat.
  return { key: 'fallback' };
}

module.exports = { respond, normalize };
