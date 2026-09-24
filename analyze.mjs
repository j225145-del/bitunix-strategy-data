import fs from 'node:fs';
import path from 'node:path';

const GATEWAY_BASE = (process.env.GATEWAY_BASE || 'https://bitunix-data.j225145.workers.dev').replace(/\/$/, '');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const INTERVALS = ['1m', '5m', '15m'];
const INTERVAL_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
const MIN_BARS = 3;
const WARMUP_DAYS = 2;
const MAX_FRESH_ZONES = 20;
const DAY_MS = 86_400_000;
const STRATEGY_BASELINE = 'N_Structure_v0_14_2_FIX2_NO_SAME_BAR';

function taipeiDate(offsetDays = 0) {
  const nowTaipei = Date.now() + 8 * 60 * 60 * 1000 + offsetDays * DAY_MS;
  return new Date(nowTaipei).toISOString().slice(0, 10);
}

function addDays(dateStr, delta) {
  const t = Date.parse(`${dateStr}T00:00:00+08:00`) + delta * DAY_MS;
  return new Date(t + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayRange(dateStr) {
  const start = Date.parse(`${dateStr}T00:00:00+08:00`);
  return { start, end: start + DAY_MS };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchJson(url, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      if (!body?.ok) throw new Error(`Gateway returned ok=false: ${text.slice(0, 500)}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function fetchDay(symbol, interval, date) {
  const url = `${GATEWAY_BASE}/day?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&date=${encodeURIComponent(date)}`;
  const body = await fetchJson(url);
  if (!body.complete || body.missingBars !== 0 || body.receivedBars !== body.expectedBars) {
    throw new Error(`${symbol} ${interval} ${date} incomplete: expected=${body.expectedBars}, received=${body.receivedBars}, missing=${body.missingBars}`);
  }
  return body;
}

function phaseText(phase) {
  if (phase === 1) return '多N有效';
  if (phase === -1) return '空N有效';
  if (phase === 2) return '不多不空｜原多N破壞・等同向重建';
  if (phase === -2) return '不多不空｜原空N破壞・等同向重建';
  return '尚未確認方向N／強結構已失效';
}

class Core {
  constructor() {
    this.pts = [];
    this.bull = { top: NaN, bot: NaN, start: NaN, born: NaN, filled: false };
    this.bear = { top: NaN, bot: NaN, start: NaN, born: NaN, filled: false };
    this.rh = NaN; this.rl = NaN; this.rt = NaN; this.rb = NaN; this.travel = 0;
    this.pull = NaN; this.pullT = NaN; this.pullB = NaN; this.pullK = NaN;
    this.hasN = false; this.broken = false; this.strong = NaN; this.weak = NaN; this.direction = 0;
    this.acceptedB = NaN; this.acceptedC = NaN; this.seq = 0;
    this.base = false; this.armed = false; this.fired = false; this.bd = 0;
    this.a = NaN; this.ab = NaN; this.ak = NaN;
    this.c = NaN; this.d = NaN; this.dt = NaN; this.dk = NaN;
    this.e = NaN; this.et = NaN; this.ek = NaN;
    this.pendingDir = 0; this.pendingAnchor = NaN; this.pendingStart = NaN; this.pendingBos = NaN;
    this.pendingLevel = NaN; this.pendingLevelTime = NaN;
    this.bosId = 0; this.outId = 0; this.outDir = 0; this.outTop = NaN; this.outBot = NaN;
    this.outGT = NaN; this.outGB = NaN; this.outTime = NaN; this.outStart = NaN; this.outBos = NaN;
    this.events = [];
  }

  event(type, eventTime, extra = {}) {
    this.events.push({ type, time: eventTime, ...extra });
  }

  point(p, t, b, key, kind, eventTime) {
    let changed = false;
    const n = this.pts.length;
    if (n === 0) {
      this.pts.push({ p, t, b, key, kind });
      changed = true;
    } else {
      const last = this.pts[n - 1];
      if (last.kind === kind) {
        if (kind * (p - last.p) > 0) {
          this.pts[n - 1] = { p, t, b, key, kind };
          changed = true;
        }
      } else if (kind * (p - last.p) > 0) {
        this.pts.push({ p, t, b, key, kind });
        this.seq += 1;
        if (this.pts.length > 4) this.pts.shift();
        changed = true;
      }
    }

    if (changed && this.pts.length === 4) {
      const [a, b1, c, d] = this.pts;
      const ordered = a.key < b1.key && b1.key < c.key && c.key < d.key;
      const shape = d.kind * (c.p - a.p) > 0 && d.kind * (d.p - b1.p) > 0;
      const fresh = !Number.isFinite(this.acceptedB) || b1.key !== this.acceptedB || c.key !== this.acceptedC;
      if (ordered && shape && d.b - a.b + 1 >= MIN_BARS) {
        if (fresh) {
          if (!this.armed && !this.fired) {
            this.base = true;
            this.bd = d.kind;
            this.a = a.p; this.ab = a.b; this.ak = a.key;
            this.c = c.p; this.d = d.p; this.dt = d.t; this.dk = d.key;
          }
          this.hasN = true;
          this.broken = false;
          this.strong = c.p;
          this.weak = d.p;
          this.direction = d.kind;
          this.acceptedB = b1.key;
          this.acceptedC = c.key;
          this.event('N_CONFIRMED', eventTime, {
            dir: d.kind,
            strong: c.p,
            weak: d.p,
            pivotStartTime: a.t,
            pivotEndTime: d.t,
          });
        } else if (!this.broken) {
          this.weak = d.p;
        }
      }
    }
    return changed;
  }

  watch(p, key, t, b, tc) {
    if (this.base && key > this.dk) {
      if (this.bd * (p - this.a) <= 0) {
        this.base = false;
        this.armed = false;
        this.event('BASE_INVALIDATED', tc, { dir: this.bd, price: p });
      } else if (!this.armed) {
        if (this.bd * (p - this.c) < 0) {
          this.armed = true;
          this.e = p; this.et = t; this.ek = key;
          this.event('NEUTRAL_ENTER', tc, { fromDir: this.bd, breakPrice: p, originalWeak: this.d });
        } else if (this.bd * (p - this.d) > 0) {
          this.d = p; this.dt = t; this.dk = key;
        }
      } else {
        if (this.bd * (p - this.e) < 0) {
          this.e = p; this.et = t; this.ek = key;
        }
        const orderOK = this.ak < this.dk && this.dk < this.ek && this.ek < key;
        if (orderOK && this.bd * (p - this.d) > 0 && b - this.ab + 1 >= MIN_BARS) {
          this.fired = true;
          this.bosId += 1;
          this.pendingDir = this.bd;
          this.pendingAnchor = this.e;
          this.pendingStart = this.et;
          this.pendingBos = tc;
          this.pendingLevel = this.d;
          this.pendingLevelTime = this.dt;
          this.event('BOS', tc, {
            id: this.bosId,
            dir: this.bd,
            level: this.d,
            anchor: this.e,
            originalStart: this.a,
          });
          this.c = this.e;
          this.d = p; this.dt = t; this.dk = key;
          this.armed = false;
        }
      }
    }
  }

  processBar(bar, bars, i) {
    const h = bar.high, l = bar.low, t = bar.time, tc = bar.closeTime, b = i;
    this.fired = false;

    if (Number.isFinite(this.bull.born) && t > this.bull.born && l <= this.bull.bot) this.bull.filled = true;
    if (Number.isFinite(this.bear.born) && t > this.bear.born && h >= this.bear.top) this.bear.filled = true;

    if (i >= 2) {
      const h2 = bars[i - 2].high;
      const l2 = bars[i - 2].low;
      const t2 = bars[i - 2].time;
      if (l > h2) {
        this.bull = { top: l, bot: h2, start: t2, born: t, filled: false };
        this.event('FVG', tc, { dir: 1, top: l, bot: h2, start: t2, born: t });
      }
      if (h < l2) {
        this.bear = { top: l2, bot: h, start: t2, born: t, filled: false };
        this.event('FVG', tc, { dir: -1, top: l2, bot: h, start: t2, born: t });
      }
    }

    const inside = Number.isFinite(this.rh) && h <= this.rh && l >= this.rl;
    const up = Number.isFinite(this.rh) && h > this.rh;
    const down = Number.isFinite(this.rl) && l < this.rl;
    const both = up && down;
    const first = both ? this.travel : up ? 1 : down ? -1 : 0;
    // FIX2: a dual-break raw K must not create opposite pivots on the same bar.
    // If the pre-event segment direction is known, only that segment's endpoint may update here.
    // The full high/low of this bar becomes the next reference range; later CLOSED bars decide
    // continuation vs reversal. If direction is unknown, defer without assigning a pivot.
    const count = first !== 0 ? 1 : 0;
    const ownInside = this.hasN && !this.broken && l >= Math.min(this.strong, this.weak) && h <= Math.max(this.strong, this.weak);
    const wf = count > 0 ? first : this.travel;

    if (wf !== 0 && (ownInside || inside || count === 0)) {
      this.watch(wf === 1 ? h : l, b * 2, t, b, tc);
      // On a dual-break bar, do not infer an opposite-side intrabar sequence.
      // The opposite side is deferred to later closed bars.
      if (!both) this.watch(wf === 1 ? l : h, b * 2 + 1, t, b, tc);
    }

    if (ownInside) {
      if (this.pts.length > 0) {
        const tip = this.pts[this.pts.length - 1];
        const p = tip.kind === 1 ? l : h;
        if (tip.kind * (p - tip.p) < 0 && (!Number.isFinite(this.pull) || tip.kind * (p - this.pull) < 0)) {
          this.pull = p; this.pullT = t; this.pullB = b; this.pullK = b * 2;
        }
      }
    } else if (!inside && count > 0) {
      if (this.pts.length === 0) {
        this.point(first === 1 ? this.rl : this.rh, this.rt, this.rb, this.rb * 2, -first, tc);
      }
      if (Number.isFinite(this.pull)) {
        const tip = this.pts[this.pts.length - 1];
        this.point(this.pull, this.pullT, this.pullB, this.pullK, -tip.kind, tc);
        this.pull = NaN;
      }
      const steps = both ? 1 : 2;
      for (let j = 0; j < steps; j++) {
        const kind = j === 0 ? first : -first;
        const p = kind === 1 ? h : l;
        this.watch(p, b * 2 + j, t, b, tc);
        if (j < count) {
          if (this.hasN && this.direction * (p - this.strong) < 0 && !this.broken) {
            this.broken = true;
            this.event('STRONG_BREAK', tc, { fromDir: this.direction, price: p, strong: this.strong });
          }
          this.point(p, t, b, b * 2 + j, kind, tc);
        }
      }
    }

    if (!inside && count > 0) this.travel = first;
    if (!Number.isFinite(this.rh) || !inside) {
      this.rh = h; this.rl = l; this.rt = t; this.rb = b;
    }

    let out = null;
    if (this.pendingDir !== 0) {
      const lost = this.pendingDir === 1 ? l < this.pendingAnchor : h > this.pendingAnchor;
      if (lost) {
        this.event('ZONE_PENDING_CANCELLED', tc, { dir: this.pendingDir, reason: 'anchor_lost' });
        this.pendingDir = 0;
      } else {
        const g = this.pendingDir === 1 ? this.bull : this.bear;
        const eligible = Number.isFinite(g.born) && g.start >= this.pendingStart && !g.filled;
        const top = this.pendingDir === 1 ? g.bot : this.pendingAnchor;
        const bot = this.pendingDir === 1 ? this.pendingAnchor : g.top;
        if (eligible && top > bot) {
          this.outId += 1;
          this.outDir = this.pendingDir;
          this.outTop = top; this.outBot = bot;
          this.outGT = g.top; this.outGB = g.bot;
          this.outTime = tc; this.outStart = this.pendingStart; this.outBos = this.pendingBos;
          out = {
            id: this.outId, dir: this.outDir, top, bot,
            gt: g.top, gb: g.bot, born: tc,
            anchorTime: this.pendingStart, bosTime: this.pendingBos,
          };
          this.pendingDir = 0;
        } else if (this.travel === -this.pendingDir) {
          this.event('ZONE_PENDING_CANCELLED', tc, { dir: this.pendingDir, reason: 'segment_reversed_no_eligible_fvg' });
          this.pendingDir = 0;
        }
      }
    }

    const phase = this.armed ? 2 * this.bd : (this.hasN && !this.broken ? this.direction : 0);
    return { phase, out };
  }
}

function analyzeBars(bars, targetDate, symbol, interval) {
  const { start: targetStart, end: targetEnd } = dayRange(targetDate);
  const core = new Core();
  const zones = [];
  const zoneEvents = [];
  let phase = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const beforeCount = zones.length;

    // Existing zones are updated before the newly created local zone is added, matching Pine order.
    for (let z = zones.length - 1; z >= 0; z--) {
      const zone = zones[z];
      if (bar.time >= zone.born) {
        const fillNow = zone.dir === 1 ? bar.low <= zone.gb : bar.high >= zone.gt;
        if (fillNow && !zone.filled) {
          zone.filled = true;
          zone.gapEnd = bar.closeTime;
          zoneEvents.push({ type: 'ZONE_FILLED', time: bar.closeTime, zoneId: zone.id, dir: zone.dir });
        }
        const failedNow = zone.dir === 1 ? bar.low < zone.bot : bar.high > zone.top;
        if (failedNow && !zone.failed) {
          zone.failed = true;
          zoneEvents.push({ type: 'ZONE_FAILED', time: bar.closeTime, zoneId: zone.id, dir: zone.dir });
        }
        const contact = bar.high >= zone.bot && bar.low <= zone.top;
        if (contact && !Number.isFinite(zone.touched)) zone.touched = bar.time;
        if (zone.failed) zones.splice(z, 1);
      }
    }

    const step = core.processBar(bar, bars, i);
    phase = step.phase;

    if (step.out) {
      const o = step.out;
      const valid = Number.isFinite(o.born) && Number.isFinite(o.anchorTime) && Number.isFinite(o.bosTime) && Number.isFinite(o.gt) && Number.isFinite(o.gb) && o.gt > o.gb && o.top > o.bot && (o.dir === 1 || o.dir === -1);
      const intact = o.dir === 1 ? bar.low >= o.bot : bar.high <= o.top;
      if (valid && intact) {
        const zone = { ...o, touched: NaN, filled: false, gapEnd: NaN, failed: false };
        zones.push(zone);
        zoneEvents.push({ type: 'ZONE_CREATED', time: o.born, zoneId: o.id, dir: o.dir, top: o.top, bot: o.bot, gt: o.gt, gb: o.gb, bosTime: o.bosTime });
      } else if (valid) {
        zoneEvents.push({ type: 'ZONE_REJECTED_IMMEDIATE', time: bar.closeTime, zoneId: o.id, dir: o.dir });
      }
    }
  }

  const inTarget = e => e.time >= targetStart && e.time < targetEnd;
  const events = core.events.filter(inTarget);
  const zEvents = zoneEvents.filter(inTarget);

  const nEvents = events.filter(e => e.type === 'N_CONFIRMED');
  const bosEvents = events.filter(e => e.type === 'BOS');
  const fvgEvents = events.filter(e => e.type === 'FVG');
  const neutralEvents = events.filter(e => e.type === 'NEUTRAL_ENTER');
  const strongBreaks = events.filter(e => e.type === 'STRONG_BREAK');
  const created = zEvents.filter(e => e.type === 'ZONE_CREATED');
  const filled = zEvents.filter(e => e.type === 'ZONE_FILLED');
  const failed = zEvents.filter(e => e.type === 'ZONE_FAILED');
  const rejected = zEvents.filter(e => e.type === 'ZONE_REJECTED_IMMEDIATE');

  const lastTargetBar = [...bars].reverse().find(b => b.time >= targetStart && b.time < targetEnd);
  const lastClose = lastTargetBar?.close ?? NaN;

  const freshZones = zones
    .filter(z => !z.failed && !z.filled && z.born < targetEnd)
    .map(z => {
      const distance = Number.isFinite(lastClose)
        ? (lastClose > z.top ? lastClose - z.top : lastClose < z.bot ? z.bot - lastClose : 0)
        : NaN;
      return {
        id: z.id,
        dir: z.dir === 1 ? 'long' : 'short',
        top: z.top,
        bot: z.bot,
        fvgTop: z.gt,
        fvgBottom: z.gb,
        born: z.born,
        bosTime: z.bosTime,
        touched: Number.isFinite(z.touched) ? z.touched : null,
        distanceFromTargetClose: distance,
      };
    })
    .sort((a, b) => a.distanceFromTargetClose - b.distanceFromTargetClose)
    .slice(0, MAX_FRESH_ZONES);

  const bosWithZoneIds = new Set(created.map(z => z.bosTime));
  const bosWithZone = bosEvents.filter(b => bosWithZoneIds.has(b.time)).length;

  return {
    symbol,
    interval,
    targetDate,
    barCountAnalyzed: bars.length,
    targetBars: bars.filter(b => b.time >= targetStart && b.time < targetEnd).length,
    lastTargetClose: lastClose,
    endState: { code: phase, text: phaseText(phase) },
    metrics: {
      n: {
        total: nEvents.length,
        bullish: nEvents.filter(e => e.dir === 1).length,
        bearish: nEvents.filter(e => e.dir === -1).length,
      },
      neutralEntries: {
        total: neutralEvents.length,
        fromBull: neutralEvents.filter(e => e.fromDir === 1).length,
        fromBear: neutralEvents.filter(e => e.fromDir === -1).length,
      },
      strongBreaks: {
        total: strongBreaks.length,
        fromBull: strongBreaks.filter(e => e.fromDir === 1).length,
        fromBear: strongBreaks.filter(e => e.fromDir === -1).length,
      },
      bos: {
        total: bosEvents.length,
        bullish: bosEvents.filter(e => e.dir === 1).length,
        bearish: bosEvents.filter(e => e.dir === -1).length,
        withZone: bosWithZone,
        withoutZone: Math.max(0, bosEvents.length - bosWithZone),
      },
      fvg: {
        total: fvgEvents.length,
        bullish: fvgEvents.filter(e => e.dir === 1).length,
        bearish: fvgEvents.filter(e => e.dir === -1).length,
      },
      zones: {
        created: created.length,
        bullish: created.filter(e => e.dir === 1).length,
        bearish: created.filter(e => e.dir === -1).length,
        filledDuringTargetDay: filled.length,
        failedDuringTargetDay: failed.length,
        rejectedImmediately: rejected.length,
        freshAtEnd: freshZones.length,
      },
    },
    freshZones,
  };
}

function loadHistory(targetDate, days) {
  const dir = path.resolve('archive');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < targetDate)
    .sort()
    .slice(-days);
  const rows = [];
  for (const f of files) {
    try { rows.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
  }
  return rows;
}

function rollingAverages(history, symbol, interval, strategyBaseline) {
  const vals = history
    .filter(d => d?.strategyBaseline === strategyBaseline)
    .map(d => d?.results?.[symbol]?.[interval]?.metrics)
    .filter(Boolean);
  if (!vals.length) return null;
  const keys = [
    ['nTotal', m => m.n.total],
    ['bosTotal', m => m.bos.total],
    ['fvgTotal', m => m.fvg.total],
    ['zonesCreated', m => m.zones.created],
    ['zonesFilled', m => m.zones.filledDuringTargetDay],
    ['zonesFailed', m => m.zones.failedDuringTargetDay],
  ];
  const out = { sampleDays: vals.length };
  for (const [k, get] of keys) out[k] = vals.reduce((a, m) => a + get(m), 0) / vals.length;
  return out;
}

async function main() {
  const targetDate = process.env.TARGET_DATE || taipeiDate(-1);
  const warmupDates = [];
  for (let d = WARMUP_DAYS; d >= 1; d--) warmupDates.push(addDays(targetDate, -d));
  const dates = [...warmupDates, targetDate];

  const results = {};
  const dataQuality = {};

  for (const symbol of SYMBOLS) {
    results[symbol] = {};
    dataQuality[symbol] = {};
    for (const interval of INTERVALS) {
      const allBars = [];
      const dayChecks = [];
      for (const date of dates) {
        const body = await fetchDay(symbol, interval, date);
        dayChecks.push({ date, expectedBars: body.expectedBars, receivedBars: body.receivedBars, missingBars: body.missingBars, complete: body.complete });
        for (const r of body.bars) {
          allBars.push({
            time: Number(r.time),
            closeTime: Number(r.time) + INTERVAL_MS[interval],
            open: num(r.open),
            high: num(r.high),
            low: num(r.low),
            close: num(r.close),
          });
        }
      }
      const dedup = new Map(allBars.map(b => [b.time, b]));
      const bars = [...dedup.values()].sort((a, b) => a.time - b.time);
      results[symbol][interval] = analyzeBars(bars, targetDate, symbol, interval);
      dataQuality[symbol][interval] = dayChecks;
    }
  }

  const history7 = loadHistory(targetDate, 7);
  const history30 = loadHistory(targetDate, 30);
  const comparisons = {};
  for (const symbol of SYMBOLS) {
    comparisons[symbol] = {};
    for (const interval of INTERVALS) {
      comparisons[symbol][interval] = {
        avg7d: rollingAverages(history7, symbol, interval, STRATEGY_BASELINE),
        avg30d: rollingAverages(history30, symbol, interval, STRATEGY_BASELINE),
      };
    }
  }

  const output = {
    schemaVersion: 1,
    strategyBaseline: STRATEGY_BASELINE,
    algorithmNotes: {
      minRawBarsPerN: MIN_BARS,
      bos: '既有N → N內部破壞 → 不多不空 → 同方向重建 → 突破原N延伸端/弱端 → BOS → 更大同向N',
      fvg: 'bull: low > high[2]; bear: high < low[2]',
      zoneFreshness: 'FVG完整回補後保留結構背景，但退出新鮮交易候選',
      doubleBreakConfirmed: '老師已確認：推下一根；一個N至少3根原始K；不要在同一根K上建立反向兩端點',
      doubleBreakImplementation: 'FIX2：雙破K不在同一根建立反向端點；若事件前已有延伸方向，當根只允許既有段端點更新，並以該K完整高低作後續參考；後續已收盤K再確認延伸或反轉。順向保留屬目前實作延續，仍需後續人工/A-B驗證，不視為老師已確認完整規則',
      notImplemented: ['左側流動性演算法', '次級升主要規則', '老師藍框的未確認邊界規則'],
    },
    source: {
      exchange: 'Bitunix',
      market: 'Futures',
      gateway: GATEWAY_BASE,
      symbols: SYMBOLS,
      intervals: INTERVALS,
      timezone: 'Asia/Taipei',
    },
    generatedAt: new Date().toISOString(),
    targetDate,
    warmupDays: WARMUP_DAYS,
    dataQuality,
    results,
    comparisons,
  };

  fs.mkdirSync('archive', { recursive: true });
  fs.writeFileSync('latest.json', JSON.stringify(output, null, 2) + '\n');
  fs.writeFileSync(path.join('archive', `${targetDate}.json`), JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote latest.json and archive/${targetDate}.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
