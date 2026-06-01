// --- Утилиты ---

function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function barClass(percent) {
  if (percent >= 90) return "crit";
  if (percent >= 70) return "warn";
  return "";
}

function stateClass(state) {
  if (state === "running") return "state-running";
  if (state === "exited" || state === "dead") return "state-exited";
  if (state === "paused") return "state-paused";
  return "state-other";
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

// --- Метрики хоста ---

async function updateSystem() {
  try {
    const sys = await api("/api/system");
    setConn(true);

    document.getElementById("hostname").textContent = sys.os.hostname;
    document.getElementById("os-info").textContent = `${sys.os.distro} ${sys.os.release}`;
    document.getElementById("uptime").textContent = `аптайм ${fmtUptime(sys.uptime)}`;

    setMetric("host-cpu", sys.cpu.load, `${sys.cpu.cores} ядер · ${sys.cpu.model}`);
    setMetric(
      "host-mem",
      sys.mem.percent,
      `${fmtBytes(sys.mem.used)} / ${fmtBytes(sys.mem.total)}`
    );
    setMetric(
      "host-disk",
      sys.disk.percent,
      `${fmtBytes(sys.disk.used)} / ${fmtBytes(sys.disk.total)}`
    );
  } catch (e) {
    setConn(false);
  }
}

function setMetric(id, percent, sub) {
  const p = Math.round(percent);
  document.getElementById(id).textContent = p;
  const bar = document.getElementById(`${id}-bar`);
  bar.style.width = `${Math.min(percent, 100)}%`;
  bar.className = `bar-fill ${barClass(percent)}`;
  document.getElementById(`${id}-sub`).textContent = sub;
}

function setConn(ok) {
  const dot = document.getElementById("conn");
  dot.className = `dot ${ok ? "ok" : "err"}`;
}

// --- Контейнеры ---

let statsById = {};

async function updateContainers() {
  try {
    const [containers, stats] = await Promise.all([
      api("/api/containers"),
      api("/api/stats").catch(() => []),
    ]);
    statsById = Object.fromEntries(stats.map((s) => [s.id, s]));

    const running = containers.filter((c) => c.state === "running").length;
    document.getElementById("cnt-running").textContent = running;
    document.getElementById("cnt-total").textContent = containers.length;

    renderContainers(containers);
  } catch (e) {
    setConn(false);
  }
}

function renderContainers(containers) {
  const body = document.getElementById("containers-body");
  if (containers.length === 0) {
    body.innerHTML = `<tr><td colspan="9" class="muted center">Контейнеров нет</td></tr>`;
    return;
  }

  // Сортировка: запущенные сверху, затем по имени.
  containers.sort((a, b) => {
    if (a.state === "running" && b.state !== "running") return -1;
    if (a.state !== "running" && b.state === "running") return 1;
    return a.name.localeCompare(b.name);
  });

  body.innerHTML = containers
    .map((c) => {
      const s = statsById[c.id];
      const isRunning = c.state === "running";
      const cpu = s ? `${s.cpu.toFixed(1)}%` : "—";
      const mem = s
        ? `${fmtBytes(s.memUsed)}${s.memLimit ? " / " + fmtBytes(s.memLimit) : ""}`
        : "—";
      const cpuBar = s
        ? `<div class="mini-bar"><div style="width:${Math.min(s.cpu, 100)}%"></div></div>`
        : "";
      const memBar = s
        ? `<div class="mini-bar"><div style="width:${Math.min(s.memPercent, 100)}%"></div></div>`
        : "";
      const net = s ? `${fmtBytes(s.net.rx)} / ${fmtBytes(s.net.tx)}` : "—";
      const ports = c.ports.length
        ? c.ports
            .map((p) => `${p.publicPort}→${p.privatePort}/${p.type}`)
            .join("<br>")
        : "—";

      return `
        <tr>
          <td><span class="state-dot ${stateClass(c.state)}" title="${c.state}"></span></td>
          <td class="name">${esc(c.name)}</td>
          <td class="image">${esc(c.image)}</td>
          <td>${esc(c.status)}</td>
          <td>${cpu}${cpuBar}</td>
          <td>${mem}${memBar}</td>
          <td class="ports">${net}</td>
          <td class="ports">${ports}</td>
          <td>
            <div class="actions">
              <button class="btn btn-sm" onclick="showLogs('${c.id}','${esc(c.name)}')" title="Логи">📜</button>
              ${
                isRunning
                  ? `<button class="btn btn-sm btn-red" onclick="action('${c.id}','stop')" title="Стоп">⏹</button>
                     <button class="btn btn-sm" onclick="action('${c.id}','restart')" title="Рестарт">↻</button>`
                  : `<button class="btn btn-sm btn-green" onclick="action('${c.id}','start')" title="Старт">▶</button>`
              }
            </div>
          </td>
        </tr>`;
    })
    .join("");
}

function esc(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

window.action = async function (id, act) {
  try {
    await api(`/api/containers/${id}/${act}`, { method: "POST" });
    setTimeout(updateContainers, 600);
  } catch (e) {
    alert(`Ошибка: ${e.message}`);
  }
};

// --- Логи (WebSocket) ---

let logSocket = null;

window.showLogs = function (id, name) {
  closeLogs();
  document.getElementById("logs-title").textContent = name;
  document.getElementById("logs-output").textContent = "";
  document.getElementById("logs-panel").classList.remove("hidden");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  logSocket = new WebSocket(`${proto}://${location.host}/api/logs?id=${id}`);
  const out = document.getElementById("logs-output");

  logSocket.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.error) {
      out.textContent += `[ошибка] ${data.error}\n`;
      return;
    }
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent += data.log;
    if (atBottom) out.scrollTop = out.scrollHeight;
  };
  logSocket.onclose = () => {};
};

function closeLogs() {
  if (logSocket) {
    logSocket.close();
    logSocket = null;
  }
}

document.getElementById("logs-close").onclick = () => {
  closeLogs();
  document.getElementById("logs-panel").classList.add("hidden");
};
document.getElementById("logs-clear").onclick = () => {
  document.getElementById("logs-output").textContent = "";
};

// --- Циклы обновления ---

updateSystem();
updateContainers();
setInterval(updateSystem, 3000);
setInterval(updateContainers, 2500);
