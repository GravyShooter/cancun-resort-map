// script.js — builds the SPOKEN room-service script from an order JSON.
//
// The script sounds like a real person calling room service on the
// phone — NOT like a machine. No "automated assistant" identification:
// the caller speaks as the guest (the voice is a natural human voice,
// Chatty Porch), with the guest's name and room, exactly as a person
// would say it over the phone.
//
// Order JSON:
//   { "room": "6131", "guestName": "Dyer", "guest": "Dyer",
//     "language": "en"|"es",  // English unless "es"
//     "items": [{ "name": "8 oz Angus Burger", "qty": 1, "notes": "no onion" }],
//     "deliveryNotes": "Please knock, do not ring." }
// Item names are the page's English names; Spanish names come from
// menu.json (extracted from the order page). Unknown names are spoken
// in English and flagged in `unmapped`.

const fs = require('fs');
const path = require('path');

const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));
const ES_BY_EN = new Map(MENU.map((m) => [m.en.toLowerCase(), m.es]));

const EN_NUM = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty' };
const ES_NUM = { 2: 'dos', 3: 'tres', 4: 'cuatro', 5: 'cinco', 6: 'seis', 7: 'siete', 8: 'ocho', 9: 'nueve', 10: 'diez', 11: 'once', 12: 'doce', 13: 'trece', 14: 'catorce', 15: 'quince', 16: 'dieciséis', 17: 'diecisiete', 18: 'dieciocho', 19: 'diecinueve', 20: 'veinte' };

function qtyWord(qty, lang) {
  if (lang === 'es') {
    // Qty 1: no number word — the bare item name reads as one.
    return qty === 1 ? '' : (ES_NUM[qty] || String(qty));
  }
  return EN_NUM[qty] || String(qty);
}

// Pluralize an English menu name for qty > 1 ("Coke" -> "Cokes",
// "8 oz Angus Burger" -> "8 oz Angus Burgers"). Names already ending
// in "s" are left alone (already plural: "Fries", "Wings").
function pluralizeEn(name) {
  if (/s$/i.test(name)) return name;
  if (/(x|z|ch|sh)$/i.test(name)) return name + 'es';
  return name + 's';
}

function itemPhrase(item, lang) {
  const qty = item.qty || 1;
  const nameEn = (item.name || '').trim();
  let name = nameEn;
  let mapped = true;
  if (lang === 'es') {
    const es = ES_BY_EN.get(nameEn.toLowerCase());
    if (es) name = es;
    else mapped = false; // spoken in English, flagged below
  } else if (qty > 1) {
    name = pluralizeEn(name);
  }
  const q = qtyWord(qty, lang);
  let phrase = q ? q + ' ' + name : name;
  const notes = (item.notes || '').trim();
  if (notes) phrase += ', ' + notes;
  return { phrase, mapped };
}

// Join item phrases the way a person lists them:
// 1 item: "a" — 2 items: "a, and b" — 3+: "a, b, and c"
// (Spanish uses "y" instead of "and", and no comma before it:
// "a y b" — "a, b y c".)
function joinItems(phrases, lang) {
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return phrases[0];
  if (lang === 'es') {
    if (phrases.length === 2) return phrases[0] + ' y ' + phrases[1];
    return phrases.slice(0, -1).join(', ') + ' y ' + phrases[phrases.length - 1];
  }
  if (phrases.length === 2) return phrases[0] + ', and ' + phrases[1];
  return phrases.slice(0, -1).join(', ') + ', and ' + phrases[phrases.length - 1];
}

// Ensure a sentence ends with sentence punctuation.
function asSentence(text) {
  const t = text.trim();
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : t + '.';
}

function buildScript(order) {
  const room = String(order.room || '6131').trim();
  // Guest name: the order page sends guestName; fall back to the
  // older guest field, then to Dyer.
  const guest = String(order.guestName || order.guest || 'Dyer').trim() || 'Dyer';
  const lang = order.language === 'es' ? 'es' : 'en'; // default English (Spanish only when the order says so)
  const items = order.items || [];
  const deliveryNotes = (order.deliveryNotes || '').trim();
  const unmapped = [];
  const sentences = [];

  const phrases = [];
  for (const item of items) {
    const { phrase, mapped } = itemPhrase(item, lang);
    phrases.push(phrase);
    if (!mapped) unmapped.push(item.name);
  }
  const itemsText = joinItems(phrases, lang);

  if (lang === 'en') {
    // Name form; the no-name form is the guard for a blank guest
    // (the chain above defaults to Dyer when no name is supplied).
    sentences.push(guest
      ? 'Hi, this is ' + guest + ', room ' + room + '. Can I order some room service, please?'
      : 'Hi, this is room ' + room + '. Can I order some room service, please?');
    if (itemsText) sentences.push('Can I get ' + itemsText + '?');
    if (deliveryNotes) sentences.push(asSentence(deliveryNotes));
    sentences.push('That\u2019s everything. Thanks so much!');
  } else {
    sentences.push(guest
      ? 'Hola, soy ' + guest + ', habitaci\u00f3n ' + room + '. \u00bfPuedo pedir servicio a la habitaci\u00f3n, por favor?'
      : 'Hola, habitaci\u00f3n ' + room + '. \u00bfPuedo pedir servicio a la habitaci\u00f3n, por favor?');
    if (itemsText) sentences.push('\u00bfMe puede traer ' + itemsText + '?');
    if (deliveryNotes) sentences.push(asSentence(deliveryNotes));
    sentences.push('Eso es todo. \u00a1Muchas gracias!');
  }

  return {
    language: lang,
    room,
    guest,
    text: sentences.join(' '),
    lines: sentences,
    unmapped, // item names with no Spanish mapping (spoken in English)
  };
}

module.exports = { buildScript };
