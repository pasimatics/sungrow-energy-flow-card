/*
 * Sungrow Energy Flow Card
 * Animated power flow card for Sungrow hybrid inverters (Modbus, mkaiser sungrow integration).
 */

const CARD_VERSION = "0.2.0";

const DEFAULT_ENTITIES = {
  pv_power: "sensor.total_dc_power",
  load_power: "sensor.load_power",
  grid_import_power: "sensor.import_power",
  grid_export_power: "sensor.export_power",
  battery_charge_power: "sensor.battery_charging_power",
  battery_discharge_power: "sensor.battery_discharging_power",
  battery_soc: "sensor.battery_level",
  battery_energy: "sensor.battery_charge",
  battery_capacity: "sensor.battery_capacity_high_precision",
  battery_temperature: "sensor.battery_temperature",
  inverter_state: "sensor.sungrow_inverter_state",
  inverter_temperature: "sensor.inverter_temperature",
  mppt1_power: "sensor.mppt1_power",
  mppt2_power: "sensor.mppt2_power",
  daily_pv: "sensor.daily_pv_generation",
  daily_import: "sensor.daily_imported_energy",
  daily_export: "sensor.daily_exported_energy",
  daily_battery_charge_pv: "sensor.daily_battery_charge_from_pv",
  daily_battery_discharge: "sensor.daily_battery_discharge",
  daily_direct: "sensor.daily_direct_energy_consumption",
  // Lifetime counters, used for the daily history via long-term statistics
  total_import: "sensor.total_imported_energy",
  total_direct: "sensor.total_direct_energy_consumption",
  total_battery_discharge: "sensor.total_battery_discharge",
};

const HISTORY_REFRESH_MS = 30 * 60 * 1000;

const I18N = {
  de: {
    title: "Energiefluss", solar: "Solar", grid: "Netz", home: "Haus", battery: "Batterie",
    import: "Bezug", export: "Einspeisung", idle: "Ruhe",
    charging: "lädt", discharging: "entlädt", full_in: "voll in", empty_in: "leer in",
    production: "Erzeugung heute", consumption: "Verbrauch heute",
    direct: "Direkt", to_battery: "Batterie", to_grid: "Netz",
    from_solar: "Solar", from_battery: "Batterie", from_grid: "Netz",
    autarky: "Autarkie", self_consumption: "Eigenverbrauch", battery_today: "Batterie heute",
    string: "String", history: "Autarkie · letzte {n} Tage", avg: "Ø",
  },
  en: {
    title: "Energy flow", solar: "Solar", grid: "Grid", home: "Home", battery: "Battery",
    import: "Import", export: "Export", idle: "Idle",
    charging: "charging", discharging: "discharging", full_in: "full in", empty_in: "empty in",
    production: "Production today", consumption: "Consumption today",
    direct: "Direct", to_battery: "Battery", to_grid: "Grid",
    from_solar: "Solar", from_battery: "Battery", from_grid: "Grid",
    autarky: "Self-sufficiency", self_consumption: "Self-consumption", battery_today: "Battery today",
    string: "String", history: "Self-sufficiency · last {n} days", avg: "avg",
  },
};

// Layout in SVG user units (viewBox 0 0 400 400)
const VB = 400;
const NODE_R = 46;
const HUB_R = 26;
const POS = {
  pv: { x: 200, y: 62 },
  grid: { x: 62, y: 200 },
  home: { x: 338, y: 200 },
  battery: { x: 200, y: 338 },
  hub: { x: 200, y: 200 },
};

// Straight segments [x1, y1, x2, y2]; positive direction points towards the hub / the house
const FLOW_LINES = {
  pv: [POS.pv.x, POS.pv.y + NODE_R, POS.hub.x, POS.hub.y - HUB_R],
  grid: [POS.grid.x + NODE_R, POS.grid.y, POS.hub.x - HUB_R, POS.hub.y],
  battery: [POS.battery.x, POS.battery.y - NODE_R, POS.hub.x, POS.hub.y + HUB_R],
  home: [POS.hub.x + HUB_R, POS.hub.y, POS.home.x - NODE_R, POS.home.y],
};

const DOTS_PER_FLOW = 3;
const MIN_ACTIVE_W = 10;

const pct = (v) => `${(v / VB) * 100}%`;

class SungrowEnergyFlowCard extends HTMLElement {
  static getStubConfig() {
    return {};
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._flows = {};
    this._raf = null;
    this._lastTs = null;
  }

  setConfig(config) {
    this._config = {
      max_power: 10000,
      pv_max: 10000,
      animation_speed: 1,
      history_days: 14,
      ...config,
    };
    this._entities = { ...DEFAULT_ENTITIES, ...(config.entities || {}) };
    this._built = false;
    this._history = null;
    this._historyTs = 0;
    if (this._hass) {
      this._build();
      this._update();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
    this._loadHistory();
  }

  connectedCallback() {
    this._startLoop();
  }

  disconnectedCallback() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._lastTs = null;
  }

  getCardSize() {
    return 9;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  // ---------- helpers ----------

  _t(key) {
    const lang = (this._hass?.locale?.language || this._hass?.language || "en").split("-")[0];
    return (I18N[lang] || I18N.en)[key] ?? key;
  }

  _state(key) {
    const id = this._entities[key];
    return id ? this._hass?.states[id] : undefined;
  }

  _num(key) {
    const s = this._state(key);
    if (!s) return null;
    const v = parseFloat(s.state);
    return Number.isFinite(v) ? v : null;
  }

  // Power in W, regardless of W/kW unit
  _power(key) {
    const v = this._num(key);
    if (v === null) return null;
    const unit = this._state(key).attributes.unit_of_measurement;
    return unit === "kW" ? v * 1000 : v;
  }

  // Energy in kWh, regardless of Wh/kWh unit
  _energy(key) {
    const v = this._num(key);
    if (v === null) return null;
    const unit = this._state(key).attributes.unit_of_measurement;
    return unit === "Wh" ? v / 1000 : v;
  }

  _fmt(value, digits) {
    const lang = this._hass?.locale?.language || "en";
    return new Intl.NumberFormat(lang, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }

  _fmtPower(w) {
    if (w === null) return "–";
    const a = Math.abs(w);
    return a >= 1000 ? `${this._fmt(a / 1000, a >= 10000 ? 1 : 2)} kW` : `${this._fmt(a, 0)} W`;
  }

  _fmtEnergy(kwh) {
    return kwh === null ? "–" : `${this._fmt(kwh, 1)} kWh`;
  }

  _fmtDuration(hours) {
    if (!Number.isFinite(hours) || hours <= 0 || hours > 99) return "";
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
  }

  _moreInfo(key) {
    const entityId = this._entities[key];
    if (!entityId) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true })
    );
  }

  // ---------- rendering ----------

  _node(id, icon, label, infoKey, sidePos) {
    return `
      <div class="node ${id}" data-key="${infoKey}"
           style="left:${pct(POS[id].x)};top:${pct(POS[id].y)};width:${pct(NODE_R * 2)}">
        <div class="ring"></div>
        <div class="inner">
          <ha-icon icon="${icon}"></ha-icon>
          <span class="val">–</span>
          <span class="lbl">${label}</span>
        </div>
        <div class="info ${sidePos}"></div>
      </div>`;
  }

  _build() {
    if (!this._hass || !this._config) return;
    const title = this._config.title;

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        ${
          title !== false
            ? `<div class="header">
                 <div class="title">${title ?? this._t("title")}</div>
                 <div class="chip inverter"><span class="led"></span><span class="txt">–</span></div>
               </div>`
            : ""
        }
        <div class="flow">
          <svg viewBox="0 0 ${VB} ${VB}" aria-hidden="true">
            <defs>
              <filter id="glow" x="-200%" y="-200%" width="500%" height="500%">
                <feGaussianBlur stdDeviation="3" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>
            ${Object.entries(FLOW_LINES)
              .map(
                ([id, [x1, y1, x2, y2]]) => `
                <path class="track ${id}" d="M ${x1} ${y1} L ${x2} ${y2}"/>
                <g class="dots ${id}">
                  ${Array.from({ length: DOTS_PER_FLOW }, () => `<circle r="4"/>`).join("")}
                </g>`
              )
              .join("")}
          </svg>
          ${this._node("pv", "mdi:solar-power-variant", this._t("solar"), "pv_power", "side")}
          ${this._node("grid", "mdi:transmission-tower", this._t("grid"), "grid_import_power", "below")}
          ${this._node("home", "mdi:home-lightning-bolt", this._t("home"), "load_power", "below")}
          ${this._node("battery", "mdi:battery", this._t("battery"), "battery_soc", "side")}
          <div class="hub" data-key="inverter_state"
               style="left:${pct(POS.hub.x)};top:${pct(POS.hub.y)};width:${pct(HUB_R * 2)}">
            <div class="spin"></div>
            <ha-icon icon="mdi:sine-wave"></ha-icon>
          </div>
        </div>

        <div class="stats">
          <div class="bar-block production">
            <div class="bar-head"><span>${this._t("production")}</span><span class="total">–</span></div>
            <div class="bar"></div>
            <div class="legend"></div>
          </div>
          <div class="bar-block consumption">
            <div class="bar-head"><span>${this._t("consumption")}</span><span class="total">–</span></div>
            <div class="bar"></div>
            <div class="legend"></div>
          </div>
          <div class="kpis">
            <div class="kpi autarky"><div class="gauge"><span>–</span></div><div class="k-lbl">${this._t("autarky")}</div></div>
            <div class="kpi selfuse"><div class="gauge"><span>–</span></div><div class="k-lbl">${this._t("self_consumption")}</div></div>
            <div class="kpi batt">
              <div class="k-val"><span class="in">–</span><span class="out">–</span></div>
              <div class="k-lbl">${this._t("battery_today")}</div>
            </div>
          </div>
          ${
            this._config.history_days > 0
              ? `<div class="history">
                   <div class="bar-head">
                     <span>${this._t("history").replace("{n}", this._config.history_days)}</span>
                     <span class="total avg">–</span>
                   </div>
                   <div class="hist-chart"></div>
                 </div>`
              : ""
          }
        </div>
      </ha-card>`;

    const root = this.shadowRoot;
    root.querySelectorAll("[data-key]").forEach((el) =>
      el.addEventListener("click", () => this._moreInfo(el.dataset.key))
    );

    this._flows = {};
    for (const [id, line] of Object.entries(FLOW_LINES)) {
      this._flows[id] = {
        line,
        len: Math.hypot(line[2] - line[0], line[3] - line[1]),
        path: root.querySelector(`path.track.${id}`),
        dots: [...root.querySelectorAll(`g.dots.${id} circle`)],
        offset: Math.random() * 50,
        power: 0,
        dir: 1,
      };
    }
    this._built = true;
    this._startLoop();
  }

  _setFlow(id, power, dir, color) {
    const f = this._flows[id];
    if (!f) return;
    f.power = power ?? 0;
    f.dir = dir;
    const active = f.power >= MIN_ACTIVE_W;
    f.path.classList.toggle("active", active);
    f.path.style.setProperty("--c", color);
    f.dots.forEach((d) => {
      d.style.setProperty("--c", color);
      d.setAttribute("r", (2.6 + 2.2 * Math.min(1, Math.sqrt(f.power / this._config.max_power))).toFixed(2));
      d.style.display = active ? "" : "none";
    });
  }

  _setNode(id, { value, color, active, ring = 100, ringStyle = "", info = "" }) {
    const node = this.shadowRoot.querySelector(`.node.${id}`);
    if (!node) return;
    node.style.setProperty("--c", color);
    node.style.setProperty("--p", Math.max(0, Math.min(100, ring)));
    node.querySelector(".ring").style.background = ringStyle;
    node.classList.toggle("active", !!active);
    node.querySelector(".val").textContent = value;
    node.querySelector(".info").innerHTML = info;
  }

  _update() {
    if (!this._built || !this._hass) return;
    const root = this.shadowRoot;
    const c = COLORS;

    const pv = Math.max(0, this._power("pv_power") ?? 0);
    const load = Math.max(0, this._power("load_power") ?? 0);
    const gridIn = this._power("grid_import_power") ?? 0;
    const gridOut = this._power("grid_export_power") ?? 0;
    const grid = gridIn - gridOut; // >0 import
    const batIn = this._power("battery_charge_power") ?? 0;
    const batOut = this._power("battery_discharge_power") ?? 0;
    const bat = batOut - batIn; // >0 discharge
    const soc = this._num("battery_soc");

    // --- Solar ---
    const strings = ["mppt1_power", "mppt2_power"]
      .map((k, i) => ({ i: i + 1, w: this._power(k) }))
      .filter((s) => s.w !== null);
    this._setNode("pv", {
      value: this._fmtPower(pv),
      color: c.solar,
      active: pv >= MIN_ACTIVE_W,
      ring: (pv / this._config.pv_max) * 100,
      info: strings
        .map((s) => `<div><span class="muted">${this._t("string")} ${s.i}</span> ${this._fmtPower(s.w)}</div>`)
        .join(""),
    });
    this._setFlow("pv", pv, 1, c.solar);

    // --- Grid ---
    const exporting = grid < -MIN_ACTIVE_W;
    const gridColor = exporting ? c.gridOut : c.gridIn;
    this._setNode("grid", {
      value: this._fmtPower(grid),
      color: gridColor,
      active: Math.abs(grid) >= MIN_ACTIVE_W,
      info: `<span class="pill" style="--c:${gridColor}">${
        Math.abs(grid) < MIN_ACTIVE_W ? this._t("idle") : exporting ? this._t("export") : this._t("import")
      }</span>`,
    });
    this._setFlow("grid", Math.abs(grid), exporting ? -1 : 1, gridColor);

    // --- Home ---
    const mix = this._homeMix(grid, bat, load);
    this._setNode("home", {
      value: this._fmtPower(load),
      color: c.home,
      active: load >= MIN_ACTIVE_W,
      ringStyle: mix.ring,
      info: mix.legend,
    });
    this._setFlow("home", load, 1, c.home);

    // --- Battery ---
    const charging = bat < -MIN_ACTIVE_W;
    const discharging = bat > MIN_ACTIVE_W;
    const batColor = charging ? c.batIn : c.batOut;
    const energy = this._energy("battery_energy");
    const capacity = this._energy("battery_capacity");
    let eta = "";
    if (energy !== null && capacity !== null) {
      const dur = discharging
        ? this._fmtDuration(energy / (bat / 1000))
        : charging
          ? this._fmtDuration((capacity - energy) / (-bat / 1000))
          : "";
      if (dur) eta = `${this._t(discharging ? "empty_in" : "full_in")} ${dur}`;
    }
    const batTemp = this._num("battery_temperature");
    const icon = this._batteryIcon(soc, charging);
    root.querySelector(".node.battery ha-icon").setAttribute("icon", icon);
    this._setNode("battery", {
      value: soc === null ? "–" : `${this._fmt(soc, 0)} %`,
      color: soc !== null && soc < 15 ? c.low : batColor,
      active: charging || discharging,
      ring: soc ?? 0,
      info: `
        <div><b>${this._fmtPower(bat)}</b> <span class="muted">${
          charging ? this._t("charging") : discharging ? this._t("discharging") : this._t("idle")
        }</span></div>
        ${eta ? `<div class="muted">${eta}</div>` : ""}
        ${batTemp !== null ? `<div class="muted">${this._fmt(batTemp, 1)} °C</div>` : ""}`,
    });
    this._setFlow("battery", Math.abs(bat), charging ? -1 : 1, batColor);

    // --- Inverter / hub ---
    const invState = this._state("inverter_state")?.state;
    const invTemp = this._num("inverter_temperature");
    const running = !!invState && /run/i.test(invState);
    const hub = root.querySelector(".hub");
    hub.classList.toggle("active", pv + Math.abs(bat) + Math.abs(grid) > MIN_ACTIVE_W);
    const chip = root.querySelector(".chip.inverter");
    if (chip) {
      chip.classList.toggle("ok", running);
      chip.querySelector(".txt").textContent = [
        this._state("inverter_state") ? this._hass.formatEntityState?.(this._state("inverter_state")) ?? invState : null,
        invTemp !== null ? `${this._fmt(invTemp, 1)} °C` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }

    this._updateStats();
  }

  // Share of the current house load per source: ring segments plus a percentage legend
  _homeMix(grid, bat, load) {
    if (load < MIN_ACTIVE_W) return { ring: "", legend: "" };
    const fromGrid = Math.max(0, grid);
    const fromBat = Math.max(0, bat);
    const fromPv = Math.max(0, load - fromGrid - fromBat);
    const total = fromGrid + fromBat + fromPv || 1;
    const parts = [
      { w: fromPv, c: COLORS.solar },
      { w: fromBat, c: COLORS.batOut },
      { w: fromGrid, c: COLORS.gridIn },
    ].filter((p) => p.w / total >= 0.01);

    let start = 0;
    const stops = parts.map((p) => {
      const end = start + (p.w / total) * 100;
      const stop = `${p.c} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
      start = end;
      return stop;
    });
    const legend = parts
      .map((p) => `<span class="mix"><b style="background:${p.c}"></b>${this._fmt((p.w / total) * 100, 0)} %</span>`)
      .join("");
    return { ring: `conic-gradient(${stops.join(", ")})`, legend };
  }

  _batteryIcon(soc, charging) {
    if (soc === null) return "mdi:battery-unknown";
    const step = Math.round(soc / 10) * 10;
    if (charging) return step >= 100 ? "mdi:battery-charging-100" : `mdi:battery-charging-${Math.max(10, step)}`;
    if (step >= 100) return "mdi:battery";
    if (step <= 0) return "mdi:battery-outline";
    return `mdi:battery-${step}`;
  }

  _stackedBar(block, total, parts) {
    const el = this.shadowRoot.querySelector(`.bar-block.${block}`);
    el.querySelector(".total").textContent = this._fmtEnergy(total);
    const sum = parts.reduce((a, p) => a + (p.v ?? 0), 0) || 1;
    el.querySelector(".bar").innerHTML = parts
      .filter((p) => p.v > 0)
      .map((p) => `<i style="width:${(p.v / sum) * 100}%;background:${p.c}" title="${p.l}"></i>`)
      .join("");
    el.querySelector(".legend").innerHTML = parts
      .map(
        (p) =>
          `<span><b style="background:${p.c}"></b>${p.l} <span class="muted">${
            p.v === null ? "–" : this._fmt(p.v, 1)
          }</span></span>`
      )
      .join("");
  }

  _gauge(cls, value) {
    const el = this.shadowRoot.querySelector(`.kpi.${cls} .gauge`);
    el.style.setProperty("--p", value ?? 0);
    el.querySelector("span").textContent = value === null ? "–" : `${this._fmt(value, 0)} %`;
  }

  _updateStats() {
    const c = COLORS;
    const pv = this._energy("daily_pv");
    const imp = this._energy("daily_import");
    const exp = this._energy("daily_export");
    const chg = this._energy("daily_battery_charge_pv");
    const dis = this._energy("daily_battery_discharge");
    const direct = this._energy("daily_direct");

    this._stackedBar("production", pv, [
      { l: this._t("direct"), v: direct, c: c.solar },
      { l: this._t("to_battery"), v: chg, c: c.batIn },
      { l: this._t("to_grid"), v: exp, c: c.gridOut },
    ]);

    const consumption = [direct, dis, imp].every((v) => v !== null) ? direct + dis + imp : null;
    this._stackedBar("consumption", consumption, [
      { l: this._t("from_solar"), v: direct, c: c.solar },
      { l: this._t("from_battery"), v: dis, c: c.batOut },
      { l: this._t("from_grid"), v: imp, c: c.gridIn },
    ]);

    this._liveAutarky = consumption ? ((consumption - imp) / consumption) * 100 : null;
    this._gauge("autarky", this._liveAutarky);
    this._gauge("selfuse", pv ? ((pv - (exp ?? 0)) / pv) * 100 : null);

    const batt = this.shadowRoot.querySelector(".kpi.batt");
    batt.querySelector(".in").textContent = chg === null ? "–" : `+${this._fmt(chg, 1)}`;
    batt.querySelector(".out").textContent = dis === null ? "–" : `−${this._fmt(dis, 1)} kWh`;

    this._renderHistory();
  }

  // ---------- autarky history ----------

  // Daily autarky from long-term statistics of the lifetime counters:
  // (direct PV + battery discharge) / (direct PV + battery discharge + grid import)
  async _loadHistory() {
    const days = this._config.history_days;
    if (!days || this._historyLoading || Date.now() - this._historyTs < HISTORY_REFRESH_MS) return;
    this._historyLoading = true;
    const keys = ["total_import", "total_direct", "total_battery_discharge"];
    const ids = keys.map((k) => this._entities[k]);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    try {
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        period: "day",
        statistic_ids: ids,
        types: ["change"],
        units: { energy: "kWh" },
      });
      const sums = new Map(); // date string -> [import, direct, discharge]
      ids.forEach((id, idx) =>
        (res[id] || []).forEach((row) => {
          const key = new Date(typeof row.start === "number" ? row.start : Date.parse(row.start)).toDateString();
          const v = sums.get(key) || [0, 0, 0];
          v[idx] += row.change ?? 0;
          sums.set(key, v);
        })
      );
      this._history = Array.from({ length: days }, (_, i) => {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        const v = sums.get(date.toDateString());
        const cons = v ? v[0] + v[1] + v[2] : 0;
        const value = cons > 0.05 ? Math.max(0, Math.min(100, ((cons - v[0]) / cons) * 100)) : null;
        return { date, value };
      });
    } catch (err) {
      console.warn("sungrow-energy-flow-card: could not load statistics", err);
    } finally {
      this._historyTs = Date.now();
      this._historyLoading = false;
    }
    this._renderHistory();
  }

  _renderHistory() {
    const chart = this.shadowRoot.querySelector(".hist-chart");
    if (!chart || !this._history) return;
    const lang = this._hass?.locale?.language || "en";
    const today = new Date().toDateString();
    // Today's statistics lag up to an hour behind, so use the live value instead
    const days = this._history.map((d) =>
      d.date.toDateString() === today && this._liveAutarky != null ? { ...d, value: this._liveAutarky } : d
    );
    chart.innerHTML = days
      .map(({ date, value }) => {
        const isToday = date.toDateString() === today;
        const label = date.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "numeric" });
        return `
          <div class="hcol${isToday ? " today" : ""}" title="${label}: ${value === null ? "–" : `${this._fmt(value, 0)} %`}">
            <span class="hval">${value === null ? "" : this._fmt(value, 0)}</span>
            <div class="htrack"><div class="hbar" style="height:${value ?? 0}%"></div></div>
            <span class="hday">${date.toLocaleDateString(lang, { weekday: "narrow" })}</span>
          </div>`;
      })
      .join("");
    const values = days.map((d) => d.value).filter((v) => v !== null);
    this.shadowRoot.querySelector(".history .avg").textContent = values.length
      ? `${this._t("avg")} ${this._fmt(values.reduce((a, b) => a + b, 0) / values.length, 0)} %`
      : "–";
  }

  // ---------- animation ----------

  _startLoop() {
    if (this._raf || !this._built || !this.isConnected) return;
    const tick = (ts) => {
      const dt = this._lastTs === null ? 0 : Math.min(0.1, (ts - this._lastTs) / 1000);
      this._lastTs = ts;
      for (const f of Object.values(this._flows)) {
        if (f.power < MIN_ACTIVE_W) continue;
        const ratio = Math.min(1, Math.sqrt(f.power / this._config.max_power));
        const speed = (10 + 50 * ratio) * this._config.animation_speed; // user units per second
        f.offset = (f.offset + speed * dt) % f.len;
        f.dots.forEach((dot, i) => {
          const d = (f.offset + (i * f.len) / f.dots.length) % f.len;
          const t = (f.dir > 0 ? d : f.len - d) / f.len;
          const [x1, y1, x2, y2] = f.line;
          dot.setAttribute("cx", (x1 + (x2 - x1) * t).toFixed(1));
          dot.setAttribute("cy", (y1 + (y2 - y1) * t).toFixed(1));
          dot.style.opacity = Math.min(1, d / 8, (f.len - d) / 8).toFixed(2);
        });
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
}

const COLORS = {
  solar: "var(--energy-solar-color, #ff9800)",
  gridIn: "var(--energy-grid-consumption-color, #488fc2)",
  gridOut: "var(--energy-grid-return-color, #8353d1)",
  batIn: "var(--energy-battery-in-color, #f06292)",
  batOut: "var(--energy-battery-out-color, #4db6ac)",
  home: "var(--primary-color, #03a9f4)",
  low: "var(--error-color, #db4437)",
};

const STYLES = `
  :host { display: block; }
  ha-card { padding: 16px 16px 12px; overflow: hidden; }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .title { font-size: 1.2rem; font-weight: 500; color: var(--primary-text-color); }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
    font-size: .78rem; color: var(--secondary-text-color);
    background: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
    white-space: nowrap;
  }
  .chip .led { width: 8px; height: 8px; border-radius: 50%; background: var(--disabled-text-color, #999); }
  .chip.ok .led { background: var(--success-color, #43a047); box-shadow: 0 0 6px var(--success-color, #43a047); animation: pulse 2.4s ease-in-out infinite; }

  .flow {
    position: relative; width: 100%; max-width: 480px; margin: 4px auto 0;
    aspect-ratio: 1 / 1; container-type: inline-size;
  }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .track {
    fill: none; stroke: var(--divider-color, rgba(127,127,127,.3)); stroke-width: 3; stroke-linecap: round;
    transition: stroke .4s, stroke-opacity .4s;
  }
  .track.active { stroke: var(--c); stroke-opacity: .28; }
  .dots circle { fill: var(--c); filter: url(#glow); }

  .node, .hub { position: absolute; transform: translate(-50%, -50%); aspect-ratio: 1; cursor: pointer; }
  .node .ring {
    position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(var(--c) calc(var(--p, 100) * 1%), color-mix(in srgb, var(--c) 18%, transparent) 0);
    transition: box-shadow .5s, background .5s;
  }
  .node.active .ring { box-shadow: 0 0 5cqw -1cqw var(--c); }
  .node .inner {
    position: absolute; inset: 6%; border-radius: 50%;
    background: var(--ha-card-background, var(--card-background-color, #fff));
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .3cqw;
  }
  .node ha-icon { --mdc-icon-size: 6.6cqw; color: var(--c); transition: color .4s; }
  .node .val {
    font-size: clamp(11px, 4.1cqw, 20px); font-weight: 600; line-height: 1.1;
    color: var(--primary-text-color); font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .node .lbl { font-size: clamp(9px, 2.7cqw, 13px); color: var(--secondary-text-color); line-height: 1; }

  .info {
    position: absolute; font-size: clamp(10px, 3cqw, 13px); line-height: 1.45;
    color: var(--primary-text-color); white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  .info.side { left: calc(100% + 3.5cqw); top: 50%; transform: translateY(-50%); }
  .info.below { top: calc(100% + 2.5cqw); left: 50%; transform: translateX(-50%); text-align: center; }
  .muted { color: var(--secondary-text-color); }
  .pill {
    display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: .92em;
    color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent);
  }
  .mix { display: inline-flex; align-items: center; gap: 4px; margin: 0 4px; }
  .mix b { width: 7px; height: 7px; border-radius: 50%; }

  .hub .spin {
    position: absolute; inset: 0; border-radius: 50%;
    border: 2px dashed color-mix(in srgb, var(--primary-text-color) 30%, transparent);
    background: var(--ha-card-background, var(--card-background-color, #fff));
  }
  .hub.active .spin { border-color: var(--primary-color); animation: spin 12s linear infinite; }
  .hub ha-icon {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    --mdc-icon-size: 5.5cqw; color: var(--secondary-text-color);
  }
  .hub.active ha-icon { color: var(--primary-color); }

  .stats { margin-top: 8px; display: grid; gap: 12px; }
  .bar-head { display: flex; justify-content: space-between; font-size: .85rem; color: var(--secondary-text-color); margin-bottom: 5px; }
  .bar-head .total { color: var(--primary-text-color); font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar {
    display: flex; gap: 2px; height: 10px; border-radius: 5px; overflow: hidden;
    background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
  }
  .bar i { display: block; height: 100%; transition: width .6s; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: .78rem; color: var(--primary-text-color); }
  .legend b { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .legend .muted { font-variant-numeric: tabular-nums; }

  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 2px; }
  .kpi {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    padding: 10px 6px; border-radius: 12px;
    background: color-mix(in srgb, var(--primary-text-color) 4%, transparent);
  }
  .gauge {
    --c: var(--success-color, #43a047);
    width: 58px; aspect-ratio: 1; border-radius: 50%; position: relative;
    background: conic-gradient(var(--c) calc(var(--p, 0) * 1%), color-mix(in srgb, var(--c) 15%, transparent) 0);
    transition: background .6s;
  }
  .kpi.selfuse .gauge { --c: var(--energy-solar-color, #ff9800); }
  .gauge::after {
    content: ""; position: absolute; inset: 6px; border-radius: 50%;
    background: var(--ha-card-background, var(--card-background-color, #fff));
  }
  .gauge span {
    position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center;
    font-size: .82rem; font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums;
  }
  .k-lbl { font-size: .75rem; color: var(--secondary-text-color); text-align: center; }
  .k-val { display: flex; flex-direction: column; align-items: center; min-height: 58px; justify-content: center; font-weight: 600; font-variant-numeric: tabular-nums; }
  .k-val .in { color: var(--energy-battery-in-color, #f06292); }
  .k-val .out { color: var(--energy-battery-out-color, #4db6ac); }

  .history { margin-top: 2px; }
  .hist-chart { display: flex; gap: 3px; height: 92px; align-items: stretch; }
  .hcol { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .htrack {
    flex: 1; width: 100%; max-width: 22px; display: flex; align-items: flex-end;
    border-radius: 4px; background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
  }
  .hbar {
    width: 100%; border-radius: 4px; transition: height .6s;
    background: color-mix(in srgb, var(--success-color, #43a047) 55%, transparent);
  }
  .hcol.today .hbar { background: var(--success-color, #43a047); }
  .hval, .hday { font-size: .64rem; line-height: 1; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .hcol.today .hval, .hcol.today .hday { color: var(--primary-text-color); font-weight: 600; }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { opacity: .45; } }
  @media (prefers-reduced-motion: reduce) {
    .hub.active .spin, .chip.ok .led { animation: none; }
  }
`;

customElements.define("sungrow-energy-flow-card", SungrowEnergyFlowCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "sungrow-energy-flow-card",
  name: "Sungrow Energy Flow Card",
  description: "Animated energy flow for Sungrow hybrid inverters (Modbus)",
  preview: true,
});

console.info(`%c SUNGROW-ENERGY-FLOW-CARD %c v${CARD_VERSION} `, "background:#ff9800;color:#000;font-weight:700", "background:#333;color:#fff");
