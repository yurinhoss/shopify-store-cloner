// ISO regions; language defaults are suggestions, resolved against the destination's published locales.
export const EXCLUDED = new Set('TR UA BY KZ UZ KG TJ TM AZ IN PK BD NP LK PH ID VN KH LA MM AF IR IQ SY YE EG DZ MA TN NG KE ET TZ UG ZA TW DO SG MY CL AR VE BO PY EC PE GT HN SV NI'.split(' '));
const regions = {
  Europa: 'AL AD AT AX BA BE BG CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA BY TR',
  Ásia: 'AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TW UZ VN YE',
  América: 'AG AI AR AW BB BL BM BO BQ BR BS BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI',
  África: 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW',
  Oceania: 'AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
  Antártida: 'AQ BV TF',
};
const names = new Intl.DisplayNames(['pt-BR'], { type: 'region' });
const currencies = {EUR:'AD AT AX BE BG CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM TF VA YT BL',USD:'US AS EC FM GU IO MH MP PR PW TC TL UM VG VI',GBP:'GB GG IM JE',AUD:'AU CC CX KI NF NR TV',NZD:'NZ CK NU PN TK',DKK:'DK FO GL',CHF:'CH LI',XOF:'BJ BF CI GW ML NE SN TG',XAF:'CM CF TD CG GQ GA'};
const singles = {BR:'BRL',CA:'CAD',MX:'MXN',JP:'JPY',KR:'KRW',CN:'CNY',HK:'HKD',AE:'AED',SA:'SAR',IL:'ILS',NO:'NOK',SE:'SEK',PL:'PLN',CZ:'CZK',HU:'HUF',RO:'RON',IS:'ISK',AL:'ALL',BA:'BAM',RS:'RSD',MK:'MKD',MD:'MDL',RU:'RUB',TH:'THB',CO:'COP',UY:'UYU',QA:'QAR',KW:'KWD',BH:'BHD',OM:'OMR',JO:'JOD',LB:'LBP',AM:'AMD',GE:'GEL',MO:'MOP',MN:'MNT',BN:'BND',MV:'MVR',BT:'BTN'};
export const COUNTRIES = Object.entries(regions).flatMap(([region,codes]) => codes.split(' ').map(code => {
  const locale = new Intl.Locale(`und-${code}`).maximize();
  let language = locale.language;
  if (code === 'PT') language = 'pt-PT';
  if (code === 'BR') language = 'pt-BR';
  if (['CN','HK','MO'].includes(code)) language = code === 'CN' ? 'zh-CN' : 'zh-TW';
  return {code, name:names.of(code), region, language, currency:singles[code] || Object.keys(currencies).find(k=>currencies[k].split(' ').includes(code)) || null, excluded:EXCLUDED.has(code)};
})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
export function selectCountries(codes) {
  if (!Array.isArray(codes) || !codes.length || codes.length > 250) throw new Error('Selecione pelo menos um país.');
  return [...new Set(codes)].map(code => {
    const country=COUNTRIES.find(c=>c.code===code);
    if (!country || country.excluded) throw new Error(`País inválido ou excluído: ${code}`);
    return country;
  });
}
export function resolveLocale(country, locales, override) {
  const published=locales.filter(l=>l.published).map(l=>l.locale);
  const english=published.find(l=>l==='en') || published.find(l=>l.startsWith('en-'));
  if (!english) return {error:'Inglês não está publicado nesta loja.'};
  if (override && !published.includes(override)) return {error:'O idioma escolhido não está publicado nesta loja.'};
  // Never substitute Brazilian Portuguese for Portuguese from Portugal, or vice versa.
  const local=published.find(l=>l.toLowerCase()===country.language.toLowerCase()) ||
    (country.language.startsWith('pt-') ? published.find(l=>l==='pt') : published.find(l=>l.split('-')[0]===country.language.split('-')[0]));
  const primary=override || local;
  if (!primary) return {english,error:`Idioma sugerido ${country.language} não publicado. Escolha um idioma disponível.`};
  return {primary, english, alternate:primary===english?[]:[english], warning:!local?`Idioma local ${country.language} indisponível; usando ${primary}.`:null};
}
export const CARRIERS = {
  BR:['Correios Padrão','Correios Expresso'],US:['DHL Standard','DHL Express'],PT:['CTT Standard','CTT Expresso'],DE:['DHL Standard','DHL Express'],FR:['Colissimo Standard','Chronopost Express'],IT:['Poste Italiane Standard','Poste Italiane Express'],ES:['Correos Estándar','Correos Express'],GB:['Royal Mail Standard','Royal Mail Express'],NL:['PostNL Standard','PostNL Express'],BE:['Bpost Standard','Bpost Express'],AT:['Österreichische Post Standard','Österreichische Post Express'],CH:['Swiss Post Standard','Swiss Post Express'],IE:['An Post Standard','An Post Express'],JP:['Japan Post Standard','Yamato Express'],KR:['Korea Post Standard','Korea Post Express'],AU:['Australia Post Standard','Australia Post Express'],NZ:['NZ Post Standard','NZ Post Express'],CA:['Canada Post Standard','Canada Post Express'],AE:['Emirates Post Standard','Aramex Express'],HK:['Hongkong Post Standard','SF Express'],CN:['China Post Standard','SF Express'],MX:['Correos de México Estándar','Estafeta Express'],CO:['4-72 Estándar','Servientrega Express'],UY:['Correo Uruguayo Estándar','Correo Uruguayo Express'],SE:['PostNord Standard','PostNord Express'],NO:['Posten Standard','Posten Express'],DK:['PostNord Standard','PostNord Express'],FI:['Posti Standard','Posti Express'],PL:['Poczta Polska Standard','Poczta Polska Express']
};
export function shippingNames(country, overrides={}) {
  const defaults=CARRIERS[country.code] || ['Standard Shipping','Express Shipping'];
  const result=[overrides.standard ?? defaults[0],overrides.express ?? defaults[1]];
  if (result.some(n=>typeof n!=='string'||!n.trim()||n.length>100)) throw new Error('Nome do frete inválido.');
  return result.map(n=>n.trim());
}
