// Diagnóstico dos bancos Redis do contador. Não entra na rota pública do
// relatório: é só para o dono (mesmo STATS_TOKEN) descobrir QUAL dos dois
// bancos (Vercel KV vs Upstash Marketplace) está com os números de verdade.
import { Redis } from "@upstash/redis";

const FILES = ["macos", "windows", "linux"];
const TZ_MIN = -180; // igual a REPORT_TZ_OFFSET_MINUTES

function candidatos() {
  const pares = [
    ["kv", process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
    ["upstash", process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
  ];
  const vistos = new Set();
  return pares.filter(([, url, token]) => {
    if (!url || !token || vistos.has(url)) return false;
    vistos.add(url);
    return true;
  });
}

function host(url) {
  try {
    return new URL(url).hostname.slice(0, 28);
  } catch (err) {
    return "(url inválida)";
  }
}

function diaIso(offsetDias) {
  const now = Date.now() + TZ_MIN * 60 * 1000;
  return new Date(now + offsetDias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function espiar(cliente) {
  const por = {};
  for (const f of FILES) {
    por[f] = Number((await cliente.get(`downloads:${f}:total`)) || 0);
  }
  const dias = {};
  for (let i = 0; i < 5; i++) {
    const d = diaIso(-i);
    dias[d] = 0;
    for (const f of FILES) {
      dias[d] += Number((await cliente.get(`downloads:${f}:${d}`)) || 0);
    }
  }
  return {
    total: por.macos + por.windows + por.linux,
    macos: por.macos,
    windows: por.windows,
    linux: por.linux,
    log: Number((await cliente.llen("downloads:log")) || 0),
    dias,
  };
}

export default async function handler(req, res) {
  const esperado = process.env.STATS_TOKEN;
  const token = String(req.query.token || req.headers["x-stats-token"] || "");
  if (!esperado || token !== esperado) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const saida = [];
  for (const [nome, url, tok] of candidatos()) {
    const cliente = new Redis({ url, token: tok });
    try {
      await cliente.get("magicstat:probe");
      saida.push({ nome, host: host(url), ok: true, ...(await espiar(cliente)) });
    } catch (err) {
      saida.push({ nome, host: host(url), ok: false, erro: String(err?.message ?? err) });
    }
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true, candidatos: saida });
}
