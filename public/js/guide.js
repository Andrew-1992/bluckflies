// Step-by-step flight finder made of big picture buttons, for travellers who
// read little: 1) where to, 2) which day, 3) one way or return, 4) who is
// travelling. No typing needed; the answers become one clear request to the AI.

import { AIRPORTS, SOUTH_SUDAN, cityOf, placeNote } from './airports.js';
import { el, icon } from './dom.js';
import { hearButton, sayIfSound } from './hear.js';
import { arrow, formatDay, t } from './i18n.js';
import { routeMap } from './routeMap.js';

const ABROAD = ['NBO', 'EBB', 'ADD', 'DXB', 'CAI', 'KGL', 'IST'];
const MAX_PEOPLE = 9;
const STEPS = ['pin', 'calendar', 'swap', 'users'];

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOf(new Date(y, m - 1, d + n));
};
const LONG_DATE = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

/** "2 adults, 1 child and 1 baby under 2" in the interface language. */
export function describeTravellers({ adults, children, babies }) {
  const parts = [t('whoAdults', { n: adults, s: adults === 1 ? '' : 's' })];
  if (children) parts.push(t('whoChildren', { n: children, ren: children === 1 ? '' : 'ren' }));
  if (babies) parts.push(t('whoBabies', { n: babies, ies: babies === 1 ? '' : 'ies' }));
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} ${t('and')} ${parts.at(-1)}`;
}

/**
 * @param {{ container: HTMLElement, onSearch: (prompt: string, criteria: { legs: object[] }) => void, onSpeak: () => void, onClose: () => void }} o
 */
export function createGuide({ container, onSearch, onSpeak, onClose }) {
  const s = { step: 1, from: 'JUB', to: null, date: null, returnDate: null, isReturn: null, adults: 1, children: 0, childAges: [], babies: 0, pickFrom: false, region: 'abroad' };

  function header() {
    const back = el('button', { type: 'button', class: 'icon-btn big flip-rtl', 'aria-label': t('back') }, [icon('back', 22)]);
    back.addEventListener('click', () => go(s.step - 1));
    back.hidden = s.step === 1;
    const close = el('button', { type: 'button', class: 'icon-btn big', 'aria-label': t('close') }, [icon('close', 22)]);
    close.addEventListener('click', onClose);
    const dots = STEPS.map((ic, i) => el('span', { class: `dot${i + 1 === s.step ? ' on' : ''}${i + 1 < s.step ? ' done' : ''}`, 'aria-hidden': 'true' }, [icon(i + 1 < s.step ? 'check' : ic, 18)]));
    return el('div', { class: 'guide-head' }, [
      back,
      el('div', { class: 'progress' }, [el('div', { class: 'dots' }, dots), el('span', { class: 'step-of', text: t('stepOf', { n: s.step }) })]),
      close,
    ]);
  }

  function question(key) {
    const h = el('h2', { class: 'guide-q', tabindex: '-1', text: t(key) });
    return el('div', { class: 'guide-q-row' }, [h, hearButton(() => t(key), { label: false, size: 'lg' })]);
  }

  const summary = (withDates) => el('p', { class: 'guide-sum' }, [
    `${cityOf(s.from)} ${arrow()} ${cityOf(s.to)}`,
    withDates && s.date ? ` · ${formatDay(s.date)}` : '',
    withDates && s.isReturn && s.returnDate ? ` · ${formatDay(s.returnDate)}` : '',
  ]);

  function stepWhere() {
    const change = el('button', { type: 'button', class: 'btn ghost', text: t('change') });
    change.addEventListener('click', () => { s.pickFrom = !s.pickFrom; render(false); });
    const fromRow = el('div', { class: 'from-row' }, [el('span', { class: 'from-chip' }, [icon('pin', 18), t('fromCity', { city: cityOf(s.from) })]), change]);

    const origins = s.pickFrom ? el('div', { class: 'origin-list' }, Object.keys(AIRPORTS).map((code) => {
      const b = el('button', { type: 'button', class: `chip${code === s.from ? ' on' : ''}`, 'aria-pressed': String(code === s.from), text: cityOf(code) });
      b.addEventListener('click', () => { s.from = code; s.pickFrom = false; if (s.to === code) s.to = null; render(false); });
      return b;
    })) : null;

    // Two big tabs keep the list short: South Sudan towns or other countries.
    const regionTab = (region, key, hintKey, ic) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(s.region === region) }, [
        el('strong', {}, [icon(ic, 20), ' ', t(key)]), el('span', { text: t(hintKey) }),
      ]);
      b.addEventListener('click', () => { s.region = region; render(false); });
      return b;
    };
    const regions = el('div', { class: 'legs-switch region-switch', role: 'group', 'aria-label': t('whereTo') }, [
      regionTab('ss', 'inSouthSudan', 'inSouthSudanHint', 'pin'),
      regionTab('abroad', 'abroad', 'abroadHint', 'globe'),
    ]);
    const places = s.region === 'ss' ? SOUTH_SUDAN : ABROAD;
    const tiles = places.filter((c) => c !== s.from).map((code) => {
      const b = el('button', { type: 'button', class: 'place' }, [
        el('span', { class: 'place-art', 'aria-hidden': 'true' }, [routeMap([s.from, code], { width: 200, height: 90, compact: true })]),
        el('strong', { text: cityOf(code) }),
        el('span', { text: placeNote(code) }),
      ]);
      b.addEventListener('click', () => { s.to = code; go(2); });
      return el('li', {}, [b]);
    });
    const speakTile = el('button', { type: 'button', class: 'place speak' }, [el('span', { class: 'place-mic', 'aria-hidden': 'true' }, [icon('mic', 30)]), el('strong', { text: t('otherPlace') })]);
    speakTile.addEventListener('click', onSpeak);
    return [question('whereTo'), fromRow, origins, regions, el('ul', { class: 'place-grid' }, [...tiles, el('li', {}, [speakTile])])];
  }

  /** Big day buttons from `firstIso`, plus a calendar for any other day. */
  function dayPicker(firstIso, selected, onPick, labelFirstDays) {
    const days = Array.from({ length: 8 }, (_, i) => addDays(firstIso, i));
    const tiles = days.map((iso, i) => {
      const b = el('button', { type: 'button', class: `day${selected === iso ? ' on' : ''}` }, [
        el('span', { class: 'day-name', text: labelFirstDays && i === 0 ? t('today') : labelFirstDays && i === 1 ? t('tomorrow') : formatDay(iso, { weekday: 'long' }) }),
        el('strong', { class: 'day-num', text: String(Number(iso.slice(8, 10))) }),
        el('span', { class: 'day-month', text: formatDay(iso, { month: 'short' }) }),
      ]);
      b.addEventListener('click', () => onPick(iso));
      return el('li', {}, [b]);
    });
    const input = el('input', { type: 'date', id: 'guide-date', min: firstIso, value: selected ?? '' });
    const goBtn = el('button', { type: 'button', class: 'btn primary flip-rtl', 'aria-label': t('otherDay') }, [icon('next', 20)]);
    goBtn.addEventListener('click', () => (input.value ? onPick(input.value) : input.focus()));
    input.addEventListener('change', () => { if (input.value) onPick(input.value); });
    return [
      el('ul', { class: 'day-grid' }, tiles),
      el('div', { class: 'other-day' }, [el('label', { for: 'guide-date' }, [icon('calendar', 20), t('otherDay')]), input, goBtn]),
    ];
  }

  function stepWhen() {
    const today = isoOf(new Date());
    return [question('whichDay'), summary(false), ...dayPicker(today, s.date, (iso) => { s.date = iso; if (s.returnDate && s.returnDate <= iso) s.returnDate = null; go(3); }, true)];
  }

  function stepReturn() {
    const choice = (isReturn, iconName, key) => {
      const b = el('button', { type: 'button', class: `trip-choice${s.isReturn === isReturn ? ' on' : ''}`, 'aria-pressed': String(s.isReturn === isReturn) }, [
        el('span', { class: 'tile-icon', 'aria-hidden': 'true' }, [icon(iconName, 30)]),
        el('strong', { text: t(key) }),
      ]);
      b.addEventListener('click', () => {
        s.isReturn = isReturn;
        if (!isReturn) { s.returnDate = null; go(4); } else render(false);
      });
      return b;
    };
    const parts = [question('tripType'), summary(true), el('div', { class: 'trip-choices' }, [choice(false, 'arrow', 'oneWay'), choice(true, 'swap', 'returnTrip')])];
    if (s.isReturn) {
      const q = el('h3', { class: 'guide-sub', text: t('whichReturnDay') });
      parts.push(q, ...dayPicker(addDays(s.date, 1), s.returnDate, (iso) => { s.returnDate = iso; go(4); }, false));
    }
    return parts;
  }

  function counter(key, hintKey, value, min, max, onChange) {
    const num = el('strong', { class: 'count-num', text: String(value), 'aria-live': 'polite' });
    const icons = el('div', { class: 'people-icons', 'aria-hidden': 'true' }, Array.from({ length: value }, () => icon('user', key === 'babies' ? 18 : 24)));
    const minus = el('button', { type: 'button', class: 'step-btn', 'aria-label': `${t('fewer')}: ${t(key)}`, disabled: value <= min }, [icon('minus', 26)]);
    const plus = el('button', { type: 'button', class: 'step-btn', 'aria-label': `${t('more')}: ${t(key)}`, disabled: value >= max }, [icon('plus', 26)]);
    minus.addEventListener('click', () => onChange(value - 1));
    plus.addEventListener('click', () => onChange(value + 1));
    return el('div', { class: 'counter' }, [
      el('div', { class: 'counter-label' }, [el('strong', { text: t(key) }), el('span', { text: t(hintKey) })]),
      el('div', { class: 'stepper' }, [minus, el('div', { class: 'count-box' }, [num, icons]), plus]),
    ]);
  }

  function stepWho() {
    const total = s.adults + s.children + s.babies;
    const room = MAX_PEOPLE - total;
    const set = (k) => (v) => {
      s[k] = v;
      if (s.babies > s.adults) s.babies = s.adults; // each baby sits on an adult's lap
      // Fares depend on each child's age: keep one age per child (6 until changed).
      s.childAges = Array.from({ length: s.children }, (_, i) => s.childAges[i] ?? 6);
      render(false);
    };
    const ageStepper = (i) => {
      const age = s.childAges[i] ?? 6;
      const change = (d) => { s.childAges[i] = Math.min(11, Math.max(2, age + d)); render(false); };
      const minus = el('button', { type: 'button', class: 'step-btn', 'aria-label': `${t('fewer')}: ${t('childAge', { n: i + 1 })}`, disabled: age <= 2 }, [icon('minus', 22)]);
      const plus = el('button', { type: 'button', class: 'step-btn', 'aria-label': `${t('more')}: ${t('childAge', { n: i + 1 })}`, disabled: age >= 11 }, [icon('plus', 22)]);
      minus.addEventListener('click', () => change(-1));
      plus.addEventListener('click', () => change(1));
      return el('div', { class: 'counter child-age' }, [
        el('div', { class: 'counter-label' }, [el('strong', { text: t('childAge', { n: i + 1 }) }), el('span', { text: t('yearsOld') })]),
        el('div', { class: 'stepper' }, [minus, el('div', { class: 'count-box' }, [el('strong', { class: 'count-num', text: String(age), 'aria-live': 'polite' })]), plus]),
      ]);
    };
    // Search text for a place: airport codes resolve directly; towns without an airstrip by name.
    const query = (code) => (AIRPORTS[code]?.via ? AIRPORTS[code].city : code);
    const search = el('button', { type: 'button', class: 'btn primary huge' }, [icon('search', 24), t('searchNow')]);
    search.addEventListener('click', () => {
      const travellers = { adults: s.adults, childAges: [...s.childAges], infants: s.babies };
      onSearch(t('guidePrompt', {
        from: cityOf(s.from), to: cityOf(s.to),
        date: formatDay(s.date, LONG_DATE), iso: s.date,
        ret: s.isReturn && s.returnDate ? t('retPart', { date: formatDay(s.returnDate, LONG_DATE), iso: s.returnDate }) : '',
        who: describeTravellers(s),
      }), {
        // A return trip is one search: the airline prices both directions together.
        legs: [{
          origin: query(s.from), destination: query(s.to), departureDate: s.date,
          ...(s.isReturn && s.returnDate ? { returnDate: s.returnDate } : {}),
          ...travellers,
        }],
      });
    });
    return [
      question('howMany'),
      summary(true),
      el('div', { class: 'counters' }, [
        counter('adults', 'adultsHint', s.adults, 1, s.adults + room, set('adults')),
        counter('children', 'childrenHint', s.children, 0, s.children + room, set('children')),
        counter('babies', 'babiesHint', s.babies, 0, Math.min(s.adults, s.babies + room), set('babies')),
      ]),
      ...(s.children ? [el('div', { class: 'counters child-ages' }, s.childAges.map((_, i) => ageStepper(i)))] : []),
      search,
    ];
  }

  function render(announce = true) {
    const body = [stepWhere, stepWhen, stepReturn, stepWho][s.step - 1]();
    container.replaceChildren(header(), el('div', { class: 'guide-body' }, body));
    const q = container.querySelector('.guide-q');
    if (announce) {
      q?.focus();
      sayIfSound(q?.textContent ?? '');
    }
  }

  function go(step) {
    if (step < 1) return;
    s.step = step;
    render();
  }

  return {
    /** Opens at step 1, or at step 2 when a destination is already chosen. */
    open(to = null) {
      Object.assign(s, { to, pickFrom: false, step: to ? 2 : 1, isReturn: null, returnDate: null, children: 0, childAges: [], region: to && AIRPORTS[to]?.domestic ? 'ss' : s.region });
      render();
    },
    refresh() {
      render(false);
    },
  };
}
