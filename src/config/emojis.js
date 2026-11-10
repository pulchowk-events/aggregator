// src/config/emojis.js
// All custom Discord emoji references, centralised.
//
// Every ID below is SERVER-SPECIFIC — it only resolves if the bot is in the
// server that uploaded that emoji. Forkers must replace these with their own
// server's emoji IDs (right-click emoji in Discord -> Copy ID with Developer
// Mode on) before running against their own guild, or every formatted post
// will render `<:name:1234...>` as literal text.
//
// Keep this file limited to emoji/glyph data. No logic, no thresholds —
// those live in constants.js.

// Named single emoji, used inline (e.g. after a role ping in a formatted post).
const VERIFIED_BADGE = '<:verifiedbadge:1148118549940940890>';

// Emoji pool picked at random per message so posts don't all look identical.
// Kept as arrays so callers just do `pickRandom(TITLE_EMOJIS)`.
const TITLE_EMOJIS = [
  '<:thanksboss:1148118533557989416>',
  '<:verifiedbadge:1148118549940940890>',
  '<:sagepeek:1148120976383557671>',
  '<:sageok:1148120987880149112>',
  '<:stats:1223170580451430470>',
  '<:naboosticon:1223171018735095809>',
  '<:newmemberchat:1223171284985319446>',
  '<:invitepeople:1223171287690510356>',
  '<:owner:1223171289880068166>',
  '<:purplestar:1223171292383940658>',
  '<:wumpusjumping:1223171804038824006>',
  '<:wumpusooo:1223172190761910344>',
  '<:diamondicon:1223172480294846514>',
  '<:passed:1223172898324217937>',
  '<:serverguide:1223173690330447983>',
  '<:education:1223176114852200518>',
  '<:pinkglossybow:1223176300542300200>',
  '<:guildbanner:1227876196310716437>',
  '<:coin:1307747431341101087>',
  '<:HappyCloud:1377126757420765265>',
  '<a:67197redtick:1544744335743000576>',
  '<a:9040goldnitro:1544744388503150746>',
  '<a:9455yellowcrown:1544744393213480970>'
];

const DESCRIPTION_EMOJIS = [
  '<a:thomanuma:1148118624263995464>',
  '<a:pleasecat:1148119908975124552>',
  '<a:catkiss:1148119915392409671>',
  '<a:catstab:1148119964725809154>',
  '<a:nocat:1148119977753321513>',
  '<a:sagecry:1148120972046643250>',
  '<:plusicon:1223170298707443733>',
  '<:retweeticon:1223170307741978674>',
  '<:leapfrog:1286713769078034624>',
  '<:hehehe:1380560543827497140>',
  '<:paimon_hesitating:1388448880621916260>',
  '<a:angrypaimon:1388449054312108095>',
  '<:peepowait:1388449214664671233>',
  '<:catgirlcozy:1388449221966823434>',
  '<:gurawaveback:1388449229298602004>',
  '<a:kyokothumbsup:1388449235103649873>',
  '<a:sanjiinlove:1388449239839019080>',
  '<a:zerotwohypedfast:1388449245031436348>',
  '<a:kekwlaugh:1388449247749476413>',
  '<:gigachad:1388449252065148998>',
  '<:thumbsupmeme:1388449255508807680>',
  '<:catlaughingatyou:1388449259019567215>',
  '<:stare:1388449262853029908>',
  '<:animeshutup:1388449267684868162>',
  '<a:hertakurukuru:1388449276782317600>',
  '<:zorolike:1388449289495122012>',
  '<:crythumbsup:1388449301268660304>',
  '<:paimonthink:1388449304472981534>',
  '<:heart:1388453279972855919>',
  '<:heartwhite:1388453321974480997>',
  '<:heartpink:1388453383119306792>',
  '<:huh:1388462878012477550>',
  '<:heartache:1388462909977530368>',
  '<:kleeban:1388462913676771368>',
  '<:laughinghard:1388462916851859466>',
  '<:nobitchesmegamind:1388462921327181864>',
  '<:beluga:1388462930823090228>',
  '<:cocquite:1388462939677265920>',
  '<:eyeswoosh:1388462948099428472>',
  '<a:3124_cry:1388462962288889886>',
  '<:KEKW:1396512487301709996>',
  '<a:73288animatedarrowred:1544744340163928237>',
  '<a:82062flyingheartsredx04:1544744342638305333>',
  '<a:86774red:1544744348334293073>',
  '<a:95849prettyarrowr:1544744350783774720>',
  '<a:5055goldendiamond:1544744385642504222>',
  '<a:panic:1544744402537418822>',
  '<a:darkacademiabooks:1544744404852678787>',
  '<a:pumpkincat:1544744407583039589>',
  '<a:5038redfire:1544744409910870026>'
];

const DETAIL_EMOJIS = [
  '<:purplestar:1223171292383940658>',
  '<:newmemberchat:1223171284985319446>',
  '<:invitepeople:1223171287690510356>',
  '<:pinkglossybow:1223176300542300200>',
  '<:guildbanner:1227876196310716437>',
  '<:stats:1223170580451430470>',
  '<:wumpusjumping:1223171804038824006>',
  '<:verifiedbadge:1148118549940940890>'
];

function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = {
  VERIFIED_BADGE,
  TITLE_EMOJIS,
  DESCRIPTION_EMOJIS,
  DETAIL_EMOJIS,
  pickRandom
};
