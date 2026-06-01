import Docker from "dockerode";

// По умолчанию dockerode подключается к /var/run/docker.sock.
// Можно переопределить через DOCKER_HOST (например, для удалённого хоста).
export const docker = new Docker();

// Считает CPU% из снапшота stats так же, как это делает `docker stats`.
function calculateCpuPercent(stats) {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  if (!cpu || !pre) return 0;

  const cpuDelta = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
  const systemDelta = cpu.system_cpu_usage - pre.system_cpu_usage;
  const numCpus = cpu.online_cpus || (cpu.cpu_usage.percpu_usage?.length ?? 1);

  if (systemDelta > 0 && cpuDelta > 0) {
    return (cpuDelta / systemDelta) * numCpus * 100;
  }
  return 0;
}

function calculateMemory(stats) {
  const mem = stats.memory_stats;
  if (!mem || !mem.usage) return { used: 0, limit: 0, percent: 0 };
  // cache вычитаем, чтобы цифры совпадали с `docker stats`.
  const cache = mem.stats?.cache ?? mem.stats?.inactive_file ?? 0;
  const used = mem.usage - cache;
  const limit = mem.limit || 0;
  return {
    used,
    limit,
    percent: limit > 0 ? (used / limit) * 100 : 0,
  };
}

function calculateNetwork(stats) {
  let rx = 0;
  let tx = 0;
  for (const net of Object.values(stats.networks || {})) {
    rx += net.rx_bytes || 0;
    tx += net.tx_bytes || 0;
  }
  return { rx, tx };
}

// Краткая инфа по всем контейнерам (для списка).
export async function listContainers() {
  const containers = await docker.listContainers({ all: true });
  return containers.map((c) => ({
    id: c.Id,
    name: (c.Names?.[0] || "").replace(/^\//, ""),
    image: c.Image,
    state: c.State, // running, exited, paused, created...
    status: c.Status, // "Up 3 hours", "Exited (0) 2 days ago"
    created: c.Created,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map((p) => ({
        ip: p.IP,
        publicPort: p.PublicPort,
        privatePort: p.PrivatePort,
        type: p.Type,
      })),
  }));
}

// Снапшот метрик по всем запущенным контейнерам.
export async function statsAll() {
  const containers = await docker.listContainers({ all: false });
  const results = await Promise.all(
    containers.map(async (c) => {
      try {
        const container = docker.getContainer(c.Id);
        const stats = await container.stats({ stream: false });
        const mem = calculateMemory(stats);
        return {
          id: c.Id,
          name: (c.Names?.[0] || "").replace(/^\//, ""),
          cpu: calculateCpuPercent(stats),
          memUsed: mem.used,
          memLimit: mem.limit,
          memPercent: mem.percent,
          net: calculateNetwork(stats),
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

export async function containerAction(id, action) {
  const container = docker.getContainer(id);
  switch (action) {
    case "start":
      return container.start();
    case "stop":
      return container.stop();
    case "restart":
      return container.restart();
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

export async function inspect(id) {
  return docker.getContainer(id).inspect();
}

export { calculateCpuPercent, calculateMemory, calculateNetwork };
